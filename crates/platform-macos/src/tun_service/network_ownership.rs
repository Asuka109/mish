use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::future::BoxFuture;
use mish_runtime::TunObservationComponentState;
use serde::{Deserialize, Serialize};

use super::{
    TUN_DNS_NAMESERVER_LIMIT, TunSystemDnsResolver, TunSystemRoute, TunSystemSnapshot,
    valid_interface_name,
};
use crate::{MacOsCommand, MacOsCommandRunner, MacOsSystemCommandRunner};

const MANAGED_NETWORK_STATE_VERSION: u16 = 1;
const MANAGED_DNS_ADDRESS: IpAddr = IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1));
const NETWORK_SERVICE_LIMIT: usize = 64;
const WATCHDOG_STATE_MAX_BYTES: usize = 4_096;
const RECOVERY_RECORD_FILE_NAME: &str = "network-recovery.json";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EligibleNetworkKind {
    Ethernet,
    Wifi,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedNetworkService {
    id: String,
    interface: String,
    kind: EligibleNetworkKind,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedDnsState {
    pub(super) prior_servers: Vec<IpAddr>,
    schema_version: u16,
    service: ManagedNetworkService,
}

#[derive(Clone, Debug)]
pub(super) struct NetworkOwnershipSnapshot {
    baseline_interface_addresses: Vec<String>,
    baseline_mdns: Vec<TunSystemDnsResolver>,
    baseline_routes: Vec<TunSystemRoute>,
    pub(super) dns: ManagedDnsState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NetworkOwnershipObservation {
    pub(super) dns: TunObservationComponentState,
    pub(super) routes: TunObservationComponentState,
}

#[derive(Clone, Debug)]
pub(super) struct NetworkRecoveryJournal {
    owner_uid: u32,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NetworkApplyFailure {
    Clean,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NetworkControllerApplyFailure {
    MayHaveChanged,
    Unchanged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NetworkServiceRecord {
    enabled: bool,
    id: String,
    in_current_set: bool,
    interface: String,
    kind: Option<EligibleNetworkKind>,
    name: String,
    order: usize,
}

trait NetworkServiceInventory: Send + Sync {
    fn observe(&self) -> Result<Vec<NetworkServiceRecord>, ()>;
}

pub(super) trait TunNetworkController: Send + Sync {
    fn snapshot<'a>(
        &'a self,
        system: &'a TunSystemSnapshot,
    ) -> BoxFuture<'a, Result<NetworkOwnershipSnapshot, ()>>;

    fn apply<'a>(
        &'a self,
        snapshot: &'a NetworkOwnershipSnapshot,
        system: &'a TunSystemSnapshot,
    ) -> BoxFuture<'a, Result<(), NetworkControllerApplyFailure>>;

    fn restore<'a>(&'a self, state: &'a ManagedDnsState) -> BoxFuture<'a, Result<(), ()>>;

    fn observe<'a>(
        &'a self,
        snapshot: &'a NetworkOwnershipSnapshot,
        system: &'a TunSystemSnapshot,
        dns_applied: bool,
    ) -> BoxFuture<'a, Result<NetworkOwnershipObservation, ()>>;

    fn observe_recovery<'a>(
        &'a self,
        state: &'a ManagedDnsState,
    ) -> BoxFuture<'a, Result<TunObservationComponentState, ()>>;
}

impl NetworkRecoveryJournal {
    pub(super) fn for_enrollment(enrollment_record: &Path, owner_uid: u32) -> Result<Self, ()> {
        let parent = enrollment_record.parent().ok_or(())?;
        Ok(Self {
            owner_uid,
            path: parent.join(RECOVERY_RECORD_FILE_NAME),
        })
    }

    pub(super) fn development_root() -> Self {
        Self {
            owner_uid: 0,
            path: Path::new(crate::DEV_TUN_SERVICE_ENROLLMENT_PATH)
                .with_file_name(RECOVERY_RECORD_FILE_NAME),
        }
    }

    pub(super) fn load(&self) -> Result<Option<ManagedDnsState>, ()> {
        validate_private_parent(&self.path, self.owner_uid)?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != self.owner_uid
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || metadata.len() == 0
            || metadata.len() > WATCHDOG_STATE_MAX_BYTES as u64
        {
            return Err(());
        }
        let bytes = fs::read(&self.path).map_err(|_| ())?;
        let state = serde_json::from_slice::<ManagedDnsState>(&bytes).map_err(|_| ())?;
        validate_managed_dns_state(&state)?;
        Ok(Some(state))
    }

    pub(super) fn persist(&self, state: &ManagedDnsState) -> Result<(), ()> {
        validate_managed_dns_state(state)?;
        if let Some(existing) = self.load()? {
            return (existing == *state).then_some(()).ok_or(());
        }
        let bytes = serde_json::to_vec(state).map_err(|_| ())?;
        if bytes.is_empty() || bytes.len() > WATCHDOG_STATE_MAX_BYTES {
            return Err(());
        }
        let parent = self.path.parent().ok_or(())?;
        let temporary = parent.join(format!(
            ".{RECOVERY_RECORD_FILE_NAME}.{}",
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .map_err(|_| ())?;
            file.write_all(&bytes).map_err(|_| ())?;
            file.write_all(b"\n").map_err(|_| ())?;
            file.sync_all().map_err(|_| ())?;
            let metadata = file.metadata().map_err(|_| ())?;
            if metadata.uid() != self.owner_uid
                || metadata.permissions().mode() & 0o777 != 0o600
                || metadata.nlink() != 1
            {
                return Err(());
            }
            fs::rename(&temporary, &self.path).map_err(|_| ())?;
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| ())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub(super) fn clear(&self, expected: &ManagedDnsState) -> Result<(), ()> {
        if self.load()?.as_ref() != Some(expected) {
            return Err(());
        }
        self.remove()
    }

    fn clear_if_present(&self, expected: &ManagedDnsState) -> Result<(), ()> {
        match self.load()? {
            None => Ok(()),
            Some(current) if &current == expected => self.remove(),
            Some(_) => Err(()),
        }
    }

    fn remove(&self) -> Result<(), ()> {
        fs::remove_file(&self.path).map_err(|_| ())?;
        fs::File::open(self.path.parent().ok_or(())?)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| ())
    }
}

pub(super) struct MacOsTunNetworkController {
    inventory: Arc<dyn NetworkServiceInventory>,
    runner: Arc<dyn MacOsCommandRunner>,
}

impl MacOsTunNetworkController {
    pub(super) fn new() -> Self {
        Self {
            inventory: Arc::new(SystemConfigurationInventory),
            runner: Arc::new(MacOsSystemCommandRunner),
        }
    }

    #[cfg(test)]
    fn with_dependencies(
        inventory: Arc<dyn NetworkServiceInventory>,
        runner: Arc<dyn MacOsCommandRunner>,
    ) -> Self {
        Self { inventory, runner }
    }

    async fn default_route_interface(&self) -> Result<String, ()> {
        let output = self
            .runner
            .run(MacOsCommand::DefaultRoute)
            .await
            .map_err(|_| ())?;
        parse_default_route_interface(&output.stdout)
    }

    async fn observe_dns(&self, service: &ManagedNetworkService) -> Result<Vec<IpAddr>, ()> {
        let current = exact_service(&self.inventory.observe()?, service)?;
        let output = self
            .runner
            .run(MacOsCommand::GetDnsServers {
                service: current.name,
            })
            .await
            .map_err(|_| ())?;
        parse_dns_servers(&output.stdout, &service.name)
    }

    async fn set_dns(&self, service: &ManagedNetworkService, servers: &[IpAddr]) -> Result<(), ()> {
        if servers.len() > TUN_DNS_NAMESERVER_LIMIT {
            return Err(());
        }
        let current = exact_service(&self.inventory.observe()?, service)?;
        self.runner
            .run(MacOsCommand::SetDnsServers {
                servers: servers.iter().map(IpAddr::to_string).collect(),
                service: current.name,
            })
            .await
            .map_err(|_| ())?;
        (self.observe_dns(service).await? == servers)
            .then_some(())
            .ok_or(())
    }

    async fn service_is_selected(&self, service: &ManagedNetworkService) -> Result<(), ()> {
        let default_interface = self.default_route_interface().await?;
        let selected = select_service(&self.inventory.observe()?, &default_interface)?;
        (&selected == service).then_some(()).ok_or(())
    }
}

impl TunNetworkController for MacOsTunNetworkController {
    fn snapshot<'a>(
        &'a self,
        system: &'a TunSystemSnapshot,
    ) -> BoxFuture<'a, Result<NetworkOwnershipSnapshot, ()>> {
        Box::pin(async move {
            let interface = self.default_route_interface().await?;
            let service = select_service(&self.inventory.observe()?, &interface)?;
            let addresses = system
                .interfaces
                .iter()
                .find(|candidate| candidate.name == service.interface)
                .map(|candidate| candidate.addresses.clone())
                .filter(|addresses| !addresses.is_empty())
                .ok_or(())?;
            let prior_servers = self.observe_dns(&service).await?;
            let baseline_mdns = system
                .dns_resolvers
                .iter()
                .filter(|resolver| mdns_reaches_interface(resolver, system, &service.interface))
                .cloned()
                .collect::<Vec<_>>();
            let baseline_routes = system
                .routes
                .iter()
                .filter(|route| route.interface == service.interface)
                .cloned()
                .collect::<Vec<_>>();
            if baseline_mdns.is_empty()
                || baseline_routes.is_empty()
                || !baseline_routes
                    .iter()
                    .any(|route| route.destination == "default")
            {
                return Err(());
            }
            Ok(NetworkOwnershipSnapshot {
                baseline_interface_addresses: addresses,
                baseline_mdns,
                baseline_routes,
                dns: ManagedDnsState {
                    prior_servers,
                    schema_version: MANAGED_NETWORK_STATE_VERSION,
                    service,
                },
            })
        })
    }

    fn apply<'a>(
        &'a self,
        snapshot: &'a NetworkOwnershipSnapshot,
        system: &'a TunSystemSnapshot,
    ) -> BoxFuture<'a, Result<(), NetworkControllerApplyFailure>> {
        Box::pin(async move {
            self.service_is_selected(&snapshot.dns.service)
                .await
                .map_err(|()| NetworkControllerApplyFailure::Unchanged)?;
            validate_preserved_network(snapshot, system)
                .map_err(|()| NetworkControllerApplyFailure::Unchanged)?;
            if self
                .observe_dns(&snapshot.dns.service)
                .await
                .map_err(|()| NetworkControllerApplyFailure::Unchanged)?
                != snapshot.dns.prior_servers
            {
                return Err(NetworkControllerApplyFailure::Unchanged);
            }
            self.set_dns(&snapshot.dns.service, &[MANAGED_DNS_ADDRESS])
                .await
                .map_err(|()| NetworkControllerApplyFailure::MayHaveChanged)
        })
    }

    fn restore<'a>(&'a self, state: &'a ManagedDnsState) -> BoxFuture<'a, Result<(), ()>> {
        Box::pin(async move {
            validate_managed_dns_state(state)?;
            let observed = self.observe_dns(&state.service).await?;
            if observed == state.prior_servers {
                return Ok(());
            }
            if observed != [MANAGED_DNS_ADDRESS] {
                return Err(());
            }
            self.set_dns(&state.service, &state.prior_servers).await
        })
    }

    fn observe<'a>(
        &'a self,
        snapshot: &'a NetworkOwnershipSnapshot,
        system: &'a TunSystemSnapshot,
        dns_applied: bool,
    ) -> BoxFuture<'a, Result<NetworkOwnershipObservation, ()>> {
        Box::pin(async move {
            let inventory = self.inventory.observe()?;
            if exact_service(&inventory, &snapshot.dns.service).is_err() {
                return Ok(NetworkOwnershipObservation {
                    dns: TunObservationComponentState::Foreign,
                    routes: TunObservationComponentState::Foreign,
                });
            }
            let selected = self
                .service_is_selected(&snapshot.dns.service)
                .await
                .is_ok();
            let preserved = validate_preserved_network(snapshot, system).is_ok();
            let observed_dns = self.observe_dns(&snapshot.dns.service).await?;
            let expected_dns = if dns_applied {
                &[MANAGED_DNS_ADDRESS][..]
            } else {
                snapshot.dns.prior_servers.as_slice()
            };
            let dns = if observed_dns == expected_dns && selected && preserved {
                TunObservationComponentState::Confirmed
            } else if observed_dns == snapshot.dns.prior_servers
                || observed_dns == [MANAGED_DNS_ADDRESS]
            {
                TunObservationComponentState::Partial
            } else {
                TunObservationComponentState::Foreign
            };
            Ok(NetworkOwnershipObservation {
                dns,
                routes: if selected && preserved {
                    TunObservationComponentState::Confirmed
                } else {
                    TunObservationComponentState::Partial
                },
            })
        })
    }

    fn observe_recovery<'a>(
        &'a self,
        state: &'a ManagedDnsState,
    ) -> BoxFuture<'a, Result<TunObservationComponentState, ()>> {
        Box::pin(async move {
            if exact_service(&self.inventory.observe()?, &state.service).is_err() {
                return Ok(TunObservationComponentState::Foreign);
            }
            let observed = self.observe_dns(&state.service).await?;
            Ok(if observed == state.prior_servers {
                TunObservationComponentState::Confirmed
            } else if observed == [MANAGED_DNS_ADDRESS] {
                TunObservationComponentState::Partial
            } else {
                TunObservationComponentState::Foreign
            })
        })
    }
}

pub(super) async fn apply_network_transaction(
    controller: &dyn TunNetworkController,
    journal: &NetworkRecoveryJournal,
    snapshot: &NetworkOwnershipSnapshot,
    system: &TunSystemSnapshot,
) -> Result<(), NetworkApplyFailure> {
    if journal.persist(&snapshot.dns).is_err() {
        return Err(NetworkApplyFailure::Clean);
    }
    match controller.apply(snapshot, system).await {
        Ok(()) => Ok(()),
        Err(NetworkControllerApplyFailure::Unchanged) => {
            if journal.clear(&snapshot.dns).is_ok() {
                Err(NetworkApplyFailure::Clean)
            } else {
                Err(NetworkApplyFailure::RecoveryRequired)
            }
        }
        Err(NetworkControllerApplyFailure::MayHaveChanged) => {
            if controller.restore(&snapshot.dns).await.is_ok()
                && journal.clear(&snapshot.dns).is_ok()
            {
                Err(NetworkApplyFailure::Clean)
            } else {
                Err(NetworkApplyFailure::RecoveryRequired)
            }
        }
    }
}

pub(super) async fn restore_network_transaction(
    controller: &dyn TunNetworkController,
    journal: &NetworkRecoveryJournal,
    state: &ManagedDnsState,
) -> Result<(), ()> {
    controller.restore(state).await?;
    journal.clear(state)
}

pub(super) async fn restore_network_transaction_if_recorded(
    controller: &dyn TunNetworkController,
    journal: &NetworkRecoveryJournal,
    state: &ManagedDnsState,
) -> Result<(), ()> {
    controller.restore(state).await?;
    journal.clear_if_present(state)
}

fn validate_preserved_network(
    snapshot: &NetworkOwnershipSnapshot,
    system: &TunSystemSnapshot,
) -> Result<(), ()> {
    let current_addresses = system
        .interfaces
        .iter()
        .find(|interface| interface.name == snapshot.dns.service.interface)
        .map(|interface| interface.addresses.as_slice())
        .ok_or(())?;
    if current_addresses != snapshot.baseline_interface_addresses {
        return Err(());
    }
    if !snapshot
        .baseline_routes
        .iter()
        .all(|route| system.routes.contains(route))
        || !snapshot
            .baseline_mdns
            .iter()
            .all(|resolver| system.dns_resolvers.contains(resolver))
    {
        return Err(());
    }
    Ok(())
}

fn select_service(
    services: &[NetworkServiceRecord],
    default_interface: &str,
) -> Result<ManagedNetworkService, ()> {
    if services.len() > NETWORK_SERVICE_LIMIT || !valid_interface_name(default_interface) {
        return Err(());
    }
    let mut candidates = services
        .iter()
        .filter(|service| {
            service.enabled
                && service.in_current_set
                && service.interface == default_interface
                && service.kind.is_some()
                && valid_service_record(service)
        })
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Err(());
    }
    let service = candidates.remove(0);
    Ok(ManagedNetworkService {
        id: service.id.clone(),
        interface: service.interface.clone(),
        kind: service.kind.ok_or(())?,
        name: service.name.clone(),
    })
}

fn exact_service(
    services: &[NetworkServiceRecord],
    expected: &ManagedNetworkService,
) -> Result<NetworkServiceRecord, ()> {
    validate_managed_service(expected)?;
    let matches = services
        .iter()
        .filter(|service| {
            service.enabled
                && service.in_current_set
                && service.id == expected.id
                && service.interface == expected.interface
                && service.kind == Some(expected.kind)
                && service.name == expected.name
                && valid_service_record(service)
        })
        .cloned()
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0].clone()).ok_or(())
}

fn valid_service_record(service: &NetworkServiceRecord) -> bool {
    uuid::Uuid::parse_str(&service.id).is_ok()
        && valid_interface_name(&service.interface)
        && valid_service_name(&service.name)
        && service.order < NETWORK_SERVICE_LIMIT
}

fn valid_managed_service(service: &ManagedNetworkService) -> bool {
    uuid::Uuid::parse_str(&service.id).is_ok()
        && valid_interface_name(&service.interface)
        && valid_service_name(&service.name)
}

fn validate_managed_service(service: &ManagedNetworkService) -> Result<(), ()> {
    valid_managed_service(service).then_some(()).ok_or(())
}

fn valid_service_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 253 && !value.chars().any(char::is_control)
}

fn validate_private_parent(path: &Path, owner_uid: u32) -> Result<(), ()> {
    let parent = path.parent().ok_or(())?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(());
    }
    Ok(())
}

fn validate_managed_dns_state(state: &ManagedDnsState) -> Result<(), ()> {
    if state.schema_version != MANAGED_NETWORK_STATE_VERSION
        || state.prior_servers.len() > TUN_DNS_NAMESERVER_LIMIT
        || !valid_managed_service(&state.service)
    {
        return Err(());
    }
    Ok(())
}

fn parse_default_route_interface(output: &str) -> Result<String, ()> {
    let interfaces = output
        .lines()
        .filter_map(|line| line.trim().split_once(':'))
        .filter_map(|(key, value)| (key.trim() == "interface").then_some(value.trim()))
        .filter(|value| valid_interface_name(value))
        .collect::<Vec<_>>();
    (interfaces.len() == 1)
        .then(|| interfaces[0].to_owned())
        .ok_or(())
}

fn parse_dns_servers(output: &str, service_name: &str) -> Result<Vec<IpAddr>, ()> {
    let output = output.trim();
    if output == format!("There aren't any DNS Servers set on {service_name}.") {
        return Ok(Vec::new());
    }
    let servers = output
        .lines()
        .map(str::trim)
        .map(str::parse::<IpAddr>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    if servers.is_empty() || servers.len() > TUN_DNS_NAMESERVER_LIMIT {
        return Err(());
    }
    Ok(servers)
}

fn mdns_reaches_interface(
    resolver: &TunSystemDnsResolver,
    system: &TunSystemSnapshot,
    interface: &str,
) -> bool {
    resolver.port == 5353
        && resolver
            .domains
            .iter()
            .any(|domain| domain.eq_ignore_ascii_case("local"))
        && resolver.nameservers.iter().any(|address| {
            is_mdns_address(*address)
                && (resolver.interface.as_deref() == Some(interface)
                    || super::selected_route_interface(&system.routes, *address) == Some(interface))
        })
}

fn is_mdns_address(address: IpAddr) -> bool {
    address == IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251))
        || address == IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb))
}

pub(super) fn encode_watchdog_dns(state: &ManagedDnsState) -> Result<String, ()> {
    validate_managed_dns_state(state)?;
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() > WATCHDOG_STATE_MAX_BYTES {
        return Err(());
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn parse_watchdog_dns(value: &str) -> Result<ManagedDnsState, &'static str> {
    if value.is_empty() || value.len() > WATCHDOG_STATE_MAX_BYTES * 2 {
        return Err("invalid managed network restoration state");
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid managed network restoration state")?;
    if bytes.len() > WATCHDOG_STATE_MAX_BYTES {
        return Err("invalid managed network restoration state");
    }
    let state = serde_json::from_slice::<ManagedDnsState>(&bytes)
        .map_err(|_| "invalid managed network restoration state")?;
    validate_managed_dns_state(&state)
        .map(|()| state)
        .map_err(|_| "invalid managed network restoration state")
}

#[cfg(target_os = "macos")]
struct SystemConfigurationInventory;

#[cfg(target_os = "macos")]
impl NetworkServiceInventory for SystemConfigurationInventory {
    fn observe(&self) -> Result<Vec<NetworkServiceRecord>, ()> {
        use system_configuration::{
            core_foundation::{base::TCFType, string::CFString},
            network_configuration::{SCNetworkInterfaceType, SCNetworkService, SCNetworkSet},
            preferences::SCPreferences,
            sys::network_configuration::{SCNetworkServiceGetEnabled, SCNetworkServiceGetName},
        };

        let preferences = SCPreferences::default(&CFString::new("com.asuka109.mish.tun-helper"));
        let order = SCNetworkSet::new(&preferences)
            .service_order()
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        let mut records = Vec::new();
        for service in SCNetworkService::get_services(&preferences).into_iter() {
            if records.len() >= NETWORK_SERVICE_LIMIT {
                return Err(());
            }
            let id = service.id().map(|value| value.to_string()).ok_or(())?;
            let interface = service.network_interface().ok_or(())?;
            let interface_name = interface
                .bsd_name()
                .map(|value| value.to_string())
                .ok_or(())?;
            let kind = match interface.interface_type() {
                Some(SCNetworkInterfaceType::Ethernet) => Some(EligibleNetworkKind::Ethernet),
                Some(SCNetworkInterfaceType::IEEE80211) => Some(EligibleNetworkKind::Wifi),
                _ => None,
            };
            // SAFETY: SystemConfiguration returned live service references owned by the array.
            let name = unsafe {
                let value = SCNetworkServiceGetName(service.as_concrete_TypeRef());
                (!value.is_null()).then(|| CFString::wrap_under_get_rule(value).to_string())
            }
            .ok_or(())?;
            // SAFETY: the same live service reference is valid for this read-only query.
            let enabled = unsafe { SCNetworkServiceGetEnabled(service.as_concrete_TypeRef()) != 0 };
            let position = order.iter().position(|candidate| candidate == &id);
            records.push(NetworkServiceRecord {
                enabled,
                id,
                in_current_set: position.is_some(),
                interface: interface_name,
                kind,
                name,
                order: position.unwrap_or(NETWORK_SERVICE_LIMIT),
            });
        }
        Ok(records)
    }
}

#[cfg(not(target_os = "macos"))]
struct SystemConfigurationInventory;

#[cfg(not(target_os = "macos"))]
impl NetworkServiceInventory for SystemConfigurationInventory {
    fn observe(&self) -> Result<Vec<NetworkServiceRecord>, ()> {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        future::ready,
        sync::{Arc, Mutex},
    };

    use futures_util::future::BoxFuture;

    use super::super::{TunSystemInterface, TunSystemRoute};
    use super::*;
    use crate::{MacOsCommandError, MacOsCommandOutput};

    const WIFI_ID: &str = "11111111-1111-4111-8111-111111111111";
    const ETHERNET_ID: &str = "22222222-2222-4222-8222-222222222222";

    #[derive(Clone)]
    struct FixtureInventory {
        records: Arc<Mutex<Vec<NetworkServiceRecord>>>,
    }

    impl NetworkServiceInventory for FixtureInventory {
        fn observe(&self) -> Result<Vec<NetworkServiceRecord>, ()> {
            Ok(self.records.lock().unwrap().clone())
        }
    }

    struct FixtureRunner {
        commands: Mutex<Vec<MacOsCommand>>,
        dns: Mutex<Vec<IpAddr>>,
        fail_after_dns_write: Mutex<bool>,
        inventory_records: Arc<Mutex<Vec<NetworkServiceRecord>>>,
        replace_service_after_dns_write: Mutex<bool>,
        route_interfaces: Mutex<VecDeque<String>>,
    }

    impl MacOsCommandRunner for FixtureRunner {
        fn run(
            &self,
            command: MacOsCommand,
        ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
            self.commands.lock().unwrap().push(command.clone());
            let output = match command {
                MacOsCommand::DefaultRoute => {
                    let mut routes = self.route_interfaces.lock().unwrap();
                    let interface = if routes.len() > 1 {
                        routes.pop_front().unwrap()
                    } else {
                        routes.front().cloned().unwrap()
                    };
                    format!("route to: default\ninterface: {interface}\n")
                }
                MacOsCommand::GetDnsServers { service } => {
                    let dns = self.dns.lock().unwrap();
                    if dns.is_empty() {
                        format!("There aren't any DNS Servers set on {service}.\n")
                    } else {
                        dns.iter()
                            .map(IpAddr::to_string)
                            .collect::<Vec<_>>()
                            .join("\n")
                    }
                }
                MacOsCommand::SetDnsServers { servers, .. } => {
                    *self.dns.lock().unwrap() = servers
                        .iter()
                        .filter(|server| server.as_str() != "Empty")
                        .map(|server| server.parse().unwrap())
                        .collect();
                    if *self.replace_service_after_dns_write.lock().unwrap() {
                        self.inventory_records.lock().unwrap()[0].id = ETHERNET_ID.into();
                    }
                    let mut fail_after_dns_write = self.fail_after_dns_write.lock().unwrap();
                    if *fail_after_dns_write {
                        *fail_after_dns_write = false;
                        return Box::pin(ready(Err(MacOsCommandError {
                            kind: crate::MacOsCommandErrorKind::Failed,
                        })));
                    }
                    String::new()
                }
                _ => panic!("unexpected fixture command"),
            };
            Box::pin(ready(Ok(MacOsCommandOutput { stdout: output })))
        }
    }

    fn service(
        id: &str,
        name: &str,
        interface: &str,
        kind: EligibleNetworkKind,
        order: usize,
    ) -> NetworkServiceRecord {
        NetworkServiceRecord {
            enabled: true,
            id: id.into(),
            in_current_set: true,
            interface: interface.into(),
            kind: Some(kind),
            name: name.into(),
            order,
        }
    }

    fn system(interface: &str, address: &str) -> TunSystemSnapshot {
        TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                domains: vec!["local".into()],
                interface: Some(interface.into()),
                nameservers: vec!["224.0.0.251".parse().unwrap()],
                port: 5353,
            }],
            interfaces: vec![TunSystemInterface {
                addresses: vec![address.into(), "fe80::1".into()],
                name: interface.into(),
            }],
            routes: vec![
                TunSystemRoute {
                    destination: "default".into(),
                    flags: "UGScg".into(),
                    gateway: "192.168.1.1".into(),
                    interface: interface.into(),
                },
                TunSystemRoute {
                    destination: "192.168.1".into(),
                    flags: "UCS".into(),
                    gateway: "link#4".into(),
                    interface: interface.into(),
                },
                TunSystemRoute {
                    destination: "224.0.0/4".into(),
                    flags: "UmCS".into(),
                    gateway: "link#4".into(),
                    interface: interface.into(),
                },
            ],
        }
    }

    fn fixture(
        records: Vec<NetworkServiceRecord>,
        route_interfaces: Vec<&str>,
        dns: Vec<IpAddr>,
    ) -> (
        MacOsTunNetworkController,
        Arc<FixtureInventory>,
        Arc<FixtureRunner>,
    ) {
        let inventory = Arc::new(FixtureInventory {
            records: Arc::new(Mutex::new(records)),
        });
        let runner = Arc::new(FixtureRunner {
            commands: Mutex::new(Vec::new()),
            dns: Mutex::new(dns),
            fail_after_dns_write: Mutex::new(false),
            inventory_records: inventory.records.clone(),
            replace_service_after_dns_write: Mutex::new(false),
            route_interfaces: Mutex::new(route_interfaces.into_iter().map(str::to_owned).collect()),
        });
        (
            MacOsTunNetworkController::with_dependencies(inventory.clone(), runner.clone()),
            inventory,
            runner,
        )
    }

    fn recovery_fixture() -> (tempfile::TempDir, NetworkRecoveryJournal) {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let owner_uid = unsafe { libc::getuid() };
        let journal = NetworkRecoveryJournal::for_enrollment(
            &directory.path().join("enrollment.json"),
            owner_uid,
        )
        .unwrap();
        (directory, journal)
    }

    #[tokio::test]
    async fn selects_wifi_or_ethernet_by_the_actual_default_route() {
        for (record, interface, address) in [
            (
                service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0),
                "en0",
                "192.168.1.10",
            ),
            (
                service(
                    ETHERNET_ID,
                    "USB 10/100/1000 LAN",
                    "en7",
                    EligibleNetworkKind::Ethernet,
                    0,
                ),
                "en7",
                "10.0.0.10",
            ),
        ] {
            let (controller, _, _) = fixture(
                vec![record],
                vec![interface],
                vec!["192.0.2.53".parse().unwrap()],
            );
            let snapshot = controller
                .snapshot(&system(interface, address))
                .await
                .unwrap();
            assert_eq!(snapshot.dns.service.interface, interface);
        }
    }

    #[tokio::test]
    async fn multiple_active_services_mutate_only_the_unique_default_service() {
        let wifi = service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0);
        let ethernet = service(
            ETHERNET_ID,
            "Ethernet",
            "en7",
            EligibleNetworkKind::Ethernet,
            1,
        );
        let prior = vec!["192.0.2.53".parse().unwrap()];
        let (controller, _, runner) = fixture(vec![wifi, ethernet], vec!["en0"], prior.clone());
        let system = system("en0", "192.168.1.10");
        let snapshot = controller.snapshot(&system).await.unwrap();

        controller.apply(&snapshot, &system).await.unwrap();
        controller.restore(&snapshot.dns).await.unwrap();

        assert_eq!(*runner.dns.lock().unwrap(), prior);
        assert!(
            runner
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter_map(|command| match command {
                    MacOsCommand::SetDnsServers { service, .. } => Some(service),
                    _ => None,
                })
                .all(|service| service == "Wi-Fi")
        );
    }

    #[tokio::test]
    async fn ambiguous_or_foreign_default_topologies_fail_closed() {
        let duplicate = service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0);
        let (ambiguous, _, _) =
            fixture(vec![duplicate.clone(), duplicate], vec!["en0"], Vec::new());
        assert!(
            ambiguous
                .snapshot(&system("en0", "192.168.1.10"))
                .await
                .is_err()
        );

        let (foreign, _, _) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["utun9"],
            Vec::new(),
        );
        assert!(
            foreign
                .snapshot(&system("en0", "192.168.1.10"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn replacement_or_foreign_dns_is_never_overwritten_during_restore() {
        let original = service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0);
        let prior = vec!["192.0.2.53".parse().unwrap()];
        let (controller, inventory, runner) = fixture(vec![original], vec!["en0"], prior.clone());
        let system = system("en0", "192.168.1.10");
        let snapshot = controller.snapshot(&system).await.unwrap();
        controller.apply(&snapshot, &system).await.unwrap();

        inventory.records.lock().unwrap()[0].id = ETHERNET_ID.into();
        assert!(controller.restore(&snapshot.dns).await.is_err());
        assert_eq!(*runner.dns.lock().unwrap(), vec![MANAGED_DNS_ADDRESS]);

        inventory.records.lock().unwrap()[0].id = WIFI_ID.into();
        *runner.dns.lock().unwrap() = vec!["203.0.113.53".parse().unwrap()];
        assert!(controller.restore(&snapshot.dns).await.is_err());
        assert_eq!(
            *runner.dns.lock().unwrap(),
            vec!["203.0.113.53".parse::<IpAddr>().unwrap()]
        );
    }

    #[tokio::test]
    async fn failed_apply_rolls_back_exact_dns_or_stays_recoverable() {
        let original = service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0);
        let prior = vec!["192.0.2.53".parse().unwrap()];
        let baseline = system("en0", "192.168.1.10");

        let (controller, _, runner) = fixture(vec![original.clone()], vec!["en0"], prior.clone());
        let snapshot = controller.snapshot(&baseline).await.unwrap();
        let (_directory, journal) = recovery_fixture();
        *runner.fail_after_dns_write.lock().unwrap() = true;
        assert_eq!(
            apply_network_transaction(&controller, &journal, &snapshot, &baseline).await,
            Err(NetworkApplyFailure::Clean)
        );
        assert_eq!(*runner.dns.lock().unwrap(), prior);
        assert_eq!(journal.load().unwrap(), None);

        let (controller, inventory, runner) = fixture(vec![original], vec!["en0"], prior.clone());
        let snapshot = controller.snapshot(&baseline).await.unwrap();
        let (_directory, journal) = recovery_fixture();
        *runner.fail_after_dns_write.lock().unwrap() = true;
        *runner.replace_service_after_dns_write.lock().unwrap() = true;
        assert_eq!(
            apply_network_transaction(&controller, &journal, &snapshot, &baseline).await,
            Err(NetworkApplyFailure::RecoveryRequired)
        );
        assert_eq!(*runner.dns.lock().unwrap(), vec![MANAGED_DNS_ADDRESS]);
        assert_eq!(journal.load().unwrap(), Some(snapshot.dns.clone()));

        inventory.records.lock().unwrap()[0].id = WIFI_ID.into();
        *runner.replace_service_after_dns_write.lock().unwrap() = false;
        let restarted = MacOsTunNetworkController::with_dependencies(inventory, runner.clone());
        restore_network_transaction(&restarted, &journal, &snapshot.dns)
            .await
            .unwrap();
        assert_eq!(*runner.dns.lock().unwrap(), prior);
        assert_eq!(journal.load().unwrap(), None);
    }

    #[tokio::test]
    async fn interface_route_or_mdns_drift_cannot_confirm_the_transaction() {
        let (controller, _, _) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["en0"],
            vec!["192.0.2.53".parse().unwrap()],
        );
        let baseline = system("en0", "192.168.1.10");
        let snapshot = controller.snapshot(&baseline).await.unwrap();

        let mut interface_drift = baseline.clone();
        interface_drift.interfaces[0].addresses[0] = "192.168.2.10".into();
        let observed = controller
            .observe(&snapshot, &interface_drift, false)
            .await
            .unwrap();
        assert_ne!(observed.routes, TunObservationComponentState::Confirmed);

        let mut route_drift = baseline.clone();
        route_drift.routes.remove(1);
        assert_ne!(
            controller
                .observe(&snapshot, &route_drift, false)
                .await
                .unwrap()
                .routes,
            TunObservationComponentState::Confirmed
        );

        let mut mdns_drift = baseline;
        mdns_drift.dns_resolvers.clear();
        assert_ne!(
            controller
                .observe(&snapshot, &mdns_drift, false)
                .await
                .unwrap()
                .dns,
            TunObservationComponentState::Confirmed
        );
    }

    #[tokio::test]
    async fn unrelated_service_routes_do_not_join_the_owned_snapshot() {
        let (controller, _, _) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["en0"],
            vec!["192.0.2.53".parse().unwrap()],
        );
        let mut baseline = system("en0", "192.168.1.10");
        baseline.routes.push(TunSystemRoute {
            destination: "10.0.0/8".into(),
            flags: "UCS".into(),
            gateway: "link#7".into(),
            interface: "en7".into(),
        });
        let snapshot = controller.snapshot(&baseline).await.unwrap();

        baseline.routes.pop();
        assert_eq!(
            controller
                .observe(&snapshot, &baseline, false)
                .await
                .unwrap()
                .routes,
            TunObservationComponentState::Confirmed
        );
    }

    #[test]
    fn watchdog_state_is_versioned_bounded_and_rejects_arbitrary_values() {
        let state = ManagedDnsState {
            prior_servers: vec!["192.0.2.53".parse().unwrap()],
            schema_version: MANAGED_NETWORK_STATE_VERSION,
            service: ManagedNetworkService {
                id: WIFI_ID.into(),
                interface: "en0".into(),
                kind: EligibleNetworkKind::Wifi,
                name: "Wi-Fi".into(),
            },
        };
        let encoded = encode_watchdog_dns(&state).unwrap();
        assert_eq!(parse_watchdog_dns(&encoded).unwrap(), state);
        for invalid in ["", "automatic", "192.0.2.53", "not-base64"] {
            assert!(parse_watchdog_dns(invalid).is_err());
        }
    }

    #[test]
    fn recovery_journal_is_private_versioned_exact_and_symlink_safe() {
        let (directory, journal) = recovery_fixture();
        let state = ManagedDnsState {
            prior_servers: vec!["192.0.2.53".parse().unwrap()],
            schema_version: MANAGED_NETWORK_STATE_VERSION,
            service: ManagedNetworkService {
                id: WIFI_ID.into(),
                interface: "en0".into(),
                kind: EligibleNetworkKind::Wifi,
                name: "Wi-Fi".into(),
            },
        };
        journal.persist(&state).unwrap();
        assert_eq!(journal.load().unwrap(), Some(state.clone()));
        let metadata = fs::symlink_metadata(&journal.path).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert!(journal.clear(&state).is_ok());
        assert_eq!(journal.load().unwrap(), None);

        std::os::unix::fs::symlink(directory.path().join("target"), &journal.path).unwrap();
        assert!(journal.load().is_err());
        assert!(journal.persist(&state).is_err());
    }
}

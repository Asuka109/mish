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

const MANAGED_NETWORK_STATE_VERSION: u16 = 2;
const NETWORK_RECOVERY_RECORD_VERSION: u16 = 1;
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
    transaction_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum NetworkRecoveryPhase {
    Applied,
    Prepared,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkRecoveryRecord {
    phase: NetworkRecoveryPhase,
    record_schema_version: u16,
    state: ManagedDnsState,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NetworkDnsMutationFailure {
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

trait NetworkDnsSettings: Send + Sync {
    fn observe<'a>(
        &'a self,
        service: &'a ManagedNetworkService,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, ()>>;

    fn compare_and_set<'a>(
        &'a self,
        service: &'a ManagedNetworkService,
        expected: &'a [IpAddr],
        replacement: &'a [IpAddr],
    ) -> BoxFuture<'a, Result<(), NetworkDnsMutationFailure>>;
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
        Ok(self.load_record()?.map(|record| record.state))
    }

    fn load_record(&self) -> Result<Option<NetworkRecoveryRecord>, ()> {
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
        let record = serde_json::from_slice::<NetworkRecoveryRecord>(&bytes).map_err(|_| ())?;
        if record.record_schema_version != NETWORK_RECOVERY_RECORD_VERSION {
            return Err(());
        }
        validate_managed_dns_state(&record.state)?;
        Ok(Some(record))
    }

    pub(super) fn load_for_removal(&self) -> Result<Option<ManagedDnsState>, ()> {
        let parent = self.path.parent().ok_or(())?;
        match fs::symlink_metadata(parent) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
            Ok(_) => self.load(),
        }
    }

    pub(super) fn persist(&self, state: &ManagedDnsState) -> Result<(), ()> {
        validate_managed_dns_state(state)?;
        if let Some(existing) = self.load_record()? {
            return (existing.state == *state).then_some(()).ok_or(());
        }
        self.write_record(&NetworkRecoveryRecord {
            phase: NetworkRecoveryPhase::Prepared,
            record_schema_version: NETWORK_RECOVERY_RECORD_VERSION,
            state: state.clone(),
        })
    }

    fn mark_applied(&self, state: &ManagedDnsState) -> Result<(), ()> {
        validate_managed_dns_state(state)?;
        match self.load_record()? {
            Some(record)
                if record.state == *state && record.phase == NetworkRecoveryPhase::Applied =>
            {
                return Ok(());
            }
            Some(record)
                if record.state == *state && record.phase == NetworkRecoveryPhase::Prepared => {}
            Some(_) | None => return Err(()),
        }
        self.write_record(&NetworkRecoveryRecord {
            phase: NetworkRecoveryPhase::Applied,
            record_schema_version: NETWORK_RECOVERY_RECORD_VERSION,
            state: state.clone(),
        })
    }

    fn write_record(&self, record: &NetworkRecoveryRecord) -> Result<(), ()> {
        let bytes = serde_json::to_vec(record).map_err(|_| ())?;
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
        if self.load_record()?.as_ref().map(|record| &record.state) != Some(expected) {
            return Err(());
        }
        self.remove()
    }

    fn clear_if_present(&self, expected: &ManagedDnsState) -> Result<(), ()> {
        match self.load_record()? {
            None => Ok(()),
            Some(current) if &current.state == expected => self.remove(),
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
    dns_settings: Arc<dyn NetworkDnsSettings>,
    inventory: Arc<dyn NetworkServiceInventory>,
    runner: Arc<dyn MacOsCommandRunner>,
}

impl MacOsTunNetworkController {
    pub(super) fn new() -> Self {
        Self {
            dns_settings: Arc::new(SystemConfigurationDnsSettings),
            inventory: Arc::new(SystemConfigurationInventory),
            runner: Arc::new(MacOsSystemCommandRunner),
        }
    }

    #[cfg(test)]
    fn with_dependencies(
        dns_settings: Arc<dyn NetworkDnsSettings>,
        inventory: Arc<dyn NetworkServiceInventory>,
        runner: Arc<dyn MacOsCommandRunner>,
    ) -> Self {
        Self {
            dns_settings,
            inventory,
            runner,
        }
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
        self.dns_settings.observe(service).await
    }

    async fn set_dns(
        &self,
        service: &ManagedNetworkService,
        expected: &[IpAddr],
        replacement: &[IpAddr],
    ) -> Result<(), NetworkDnsMutationFailure> {
        if expected.len() > TUN_DNS_NAMESERVER_LIMIT || replacement.len() > TUN_DNS_NAMESERVER_LIMIT
        {
            return Err(NetworkDnsMutationFailure::Unchanged);
        }
        self.dns_settings
            .compare_and_set(service, expected, replacement)
            .await?;
        (self
            .observe_dns(service)
            .await
            .map_err(|_| NetworkDnsMutationFailure::MayHaveChanged)?
            == replacement)
            .then_some(())
            .ok_or(NetworkDnsMutationFailure::MayHaveChanged)
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
                .filter(|route| {
                    route.interface == service.interface && stable_physical_route(route, &addresses)
                })
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
                    transaction_id: uuid::Uuid::new_v4().to_string(),
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
            self.set_dns(
                &snapshot.dns.service,
                &snapshot.dns.prior_servers,
                &[MANAGED_DNS_ADDRESS],
            )
            .await
            .map_err(|failure| match failure {
                NetworkDnsMutationFailure::MayHaveChanged => {
                    NetworkControllerApplyFailure::MayHaveChanged
                }
                NetworkDnsMutationFailure::Unchanged => NetworkControllerApplyFailure::Unchanged,
            })
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
            match self
                .set_dns(&state.service, &[MANAGED_DNS_ADDRESS], &state.prior_servers)
                .await
            {
                Ok(()) => Ok(()),
                Err(NetworkDnsMutationFailure::Unchanged) => {
                    (self.observe_dns(&state.service).await? == state.prior_servers)
                        .then_some(())
                        .ok_or(())
                }
                Err(NetworkDnsMutationFailure::MayHaveChanged) => Err(()),
            }
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
        Ok(()) if journal.mark_applied(&snapshot.dns).is_ok() => Ok(()),
        Ok(()) => {
            if controller.restore(&snapshot.dns).await.is_ok()
                && journal.clear_if_present(&snapshot.dns).is_ok()
            {
                Err(NetworkApplyFailure::Clean)
            } else {
                Err(NetworkApplyFailure::RecoveryRequired)
            }
        }
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
    match journal.load()? {
        Some(recorded) if recorded == *state => {
            controller.restore(state).await?;
            journal.clear_if_present(state)
        }
        Some(_) => Err(()),
        None => match controller.observe_recovery(state).await? {
            TunObservationComponentState::Confirmed => Ok(()),
            TunObservationComponentState::Absent
            | TunObservationComponentState::Partial
            | TunObservationComponentState::Foreign
            | TunObservationComponentState::Unknown => Err(()),
        },
    }
}

pub(super) async fn restore_network_transaction_if_recorded(
    controller: &dyn TunNetworkController,
    journal: &NetworkRecoveryJournal,
    state: &ManagedDnsState,
) -> Result<(), ()> {
    let record = match journal.load_record()? {
        None => return Ok(()),
        Some(record) if record.state == *state => record,
        Some(_) => return Err(()),
    };
    if record.phase == NetworkRecoveryPhase::Prepared
        && controller.observe_recovery(state).await? != TunObservationComponentState::Partial
    {
        return Err(());
    }
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

fn stable_physical_route(route: &TunSystemRoute, interface_addresses: &[String]) -> bool {
    if route.destination == "default" {
        return true;
    }
    let reaches_non_host_prefix = |address: IpAddr| {
        super::parse_route_prefix(&route.destination, address).is_some_and(
            |(network, prefix_length)| {
                let host_prefix = if address.is_ipv4() { 32 } else { 128 };
                prefix_length > 1
                    && prefix_length < host_prefix
                    && super::route_contains(network, prefix_length, address)
            },
        )
    };
    interface_addresses
        .iter()
        .filter_map(|address| address.parse().ok())
        .any(reaches_non_host_prefix)
        || [
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)),
            IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb)),
        ]
        .into_iter()
        .any(reaches_non_host_prefix)
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
        || uuid::Uuid::parse_str(&state.transaction_id)
            .map(|transaction_id| transaction_id.to_string() != state.transaction_id)
            .unwrap_or(true)
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

fn mdns_reaches_interface(
    resolver: &TunSystemDnsResolver,
    system: &TunSystemSnapshot,
    interface: &str,
) -> bool {
    let local = resolver
        .domains
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case("local"));
    let explicit = resolver.port == Some(5353)
        && resolver.nameservers.iter().any(|address| {
            is_mdns_address(*address)
                && (resolver.interface.as_deref() == Some(interface)
                    || mdns_route_reaches_interface(&system.routes, *address, interface))
        });
    let implicit = resolver.port.is_none()
        && resolver.nameservers.is_empty()
        && resolver.interface.is_none()
        && [
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)),
            IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb)),
        ]
        .iter()
        .any(|address| mdns_route_reaches_interface(&system.routes, *address, interface));
    local && (explicit || implicit)
}

fn is_mdns_address(address: IpAddr) -> bool {
    address == IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251))
        || address == IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb))
}

fn mdns_route_reaches_interface(
    routes: &[TunSystemRoute],
    address: IpAddr,
    interface: &str,
) -> bool {
    routes.iter().any(|route| {
        route.interface == interface
            && super::parse_route_prefix(&route.destination, address).is_some_and(
                |(network, prefix_length)| {
                    prefix_length > 1 && super::route_contains(network, prefix_length, address)
                },
            )
    })
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

#[cfg(test)]
pub(super) fn test_network_snapshot() -> NetworkOwnershipSnapshot {
    NetworkOwnershipSnapshot {
        baseline_interface_addresses: vec!["192.168.1.10".into()],
        baseline_mdns: Vec::new(),
        baseline_routes: Vec::new(),
        dns: ManagedDnsState {
            prior_servers: vec!["192.0.2.53".parse().unwrap()],
            schema_version: MANAGED_NETWORK_STATE_VERSION,
            service: ManagedNetworkService {
                id: "11111111-1111-4111-8111-111111111111".into(),
                interface: "en0".into(),
                kind: EligibleNetworkKind::Wifi,
                name: "Wi-Fi".into(),
            },
            transaction_id: "22222222-2222-4222-8222-222222222222".into(),
        },
    }
}

#[cfg(target_os = "macos")]
struct SystemConfigurationInventory;

#[cfg(target_os = "macos")]
impl NetworkServiceInventory for SystemConfigurationInventory {
    fn observe(&self) -> Result<Vec<NetworkServiceRecord>, ()> {
        use system_configuration::{core_foundation::string::CFString, preferences::SCPreferences};

        let preferences = SCPreferences::default(&CFString::new("com.asuka109.mish.tun-helper"));
        system_configuration_services(&preferences)
    }
}

#[cfg(target_os = "macos")]
struct SystemConfigurationDnsSettings;

#[cfg(target_os = "macos")]
impl NetworkDnsSettings for SystemConfigurationDnsSettings {
    fn observe<'a>(
        &'a self,
        service: &'a ManagedNetworkService,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, ()>> {
        Box::pin(async move { system_configuration_dns(service) })
    }

    fn compare_and_set<'a>(
        &'a self,
        service: &'a ManagedNetworkService,
        expected: &'a [IpAddr],
        replacement: &'a [IpAddr],
    ) -> BoxFuture<'a, Result<(), NetworkDnsMutationFailure>> {
        Box::pin(
            async move { system_configuration_compare_and_set_dns(service, expected, replacement) },
        )
    }
}

#[cfg(target_os = "macos")]
fn system_configuration_services(
    preferences: &system_configuration::preferences::SCPreferences,
) -> Result<Vec<NetworkServiceRecord>, ()> {
    use system_configuration::{
        core_foundation::{base::TCFType, string::CFString},
        network_configuration::{SCNetworkInterfaceType, SCNetworkService, SCNetworkSet},
        sys::network_configuration::{SCNetworkServiceGetEnabled, SCNetworkServiceGetName},
    };

    let order = SCNetworkSet::new(preferences)
        .service_order()
        .into_iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    let mut records = Vec::new();
    for service in SCNetworkService::get_services(preferences).into_iter() {
        if records.len() >= NETWORK_SERVICE_LIMIT {
            return Err(());
        }
        let interface = service.network_interface().ok_or(())?;
        let kind = match interface.interface_type() {
            Some(SCNetworkInterfaceType::Ethernet) => Some(EligibleNetworkKind::Ethernet),
            Some(SCNetworkInterfaceType::IEEE80211) => Some(EligibleNetworkKind::Wifi),
            _ => continue,
        };
        let id = service.id().map(|value| value.to_string()).ok_or(())?;
        let interface_name = interface
            .bsd_name()
            .map(|value| value.to_string())
            .ok_or(())?;
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

#[cfg(target_os = "macos")]
fn system_configuration_dns(service: &ManagedNetworkService) -> Result<Vec<IpAddr>, ()> {
    use system_configuration::{
        core_foundation::{base::TCFType, string::CFString},
        network_configuration::SCNetworkService,
        preferences::SCPreferences,
        sys::network_configuration::SCNetworkServiceCopyProtocol,
    };

    let preferences = SCPreferences::default(&CFString::new("com.asuka109.mish.tun-helper"));
    exact_service(&system_configuration_services(&preferences)?, service)?;
    let protocol_type = CFString::new("DNS");
    for candidate in SCNetworkService::get_services(&preferences).into_iter() {
        if candidate.id().as_ref().map(ToString::to_string).as_deref() != Some(&service.id) {
            continue;
        }
        // SAFETY: the service belongs to this live preferences session and "DNS" is the fixed
        // SystemConfiguration DNS protocol identifier.
        let protocol = unsafe {
            SCNetworkServiceCopyProtocol(
                candidate.as_concrete_TypeRef(),
                protocol_type.as_concrete_TypeRef(),
            )
        };
        if protocol.is_null() {
            return Err(());
        }
        let result = protocol_dns_servers(protocol);
        // SAFETY: CopyProtocol returned an owned Core Foundation object.
        unsafe {
            system_configuration::core_foundation::base::CFRelease(protocol.cast());
        }
        return result;
    }
    Err(())
}

#[cfg(target_os = "macos")]
fn system_configuration_compare_and_set_dns(
    service: &ManagedNetworkService,
    expected: &[IpAddr],
    replacement: &[IpAddr],
) -> Result<(), NetworkDnsMutationFailure> {
    use system_configuration::{
        core_foundation::{
            array::CFArray,
            base::{TCFType, ToVoid},
            dictionary::{CFDictionary, CFMutableDictionary},
            string::CFString,
        },
        network_configuration::SCNetworkService,
        preferences::SCPreferences,
        sys::{
            network_configuration::{
                SCNetworkProtocolGetConfiguration, SCNetworkProtocolSetConfiguration,
                SCNetworkServiceCopyProtocol,
            },
            preferences::{
                SCPreferencesApplyChanges, SCPreferencesCommitChanges, SCPreferencesLock,
                SCPreferencesSynchronize, SCPreferencesUnlock,
            },
            schema_definitions::kSCPropNetDNSServerAddresses,
        },
    };

    let preferences = SCPreferences::default(&CFString::new("com.asuka109.mish.tun-helper"));
    // SAFETY: the preferences session is live. A non-waiting exclusive lock keeps this bounded
    // and prevents another conforming SystemConfiguration writer from changing the value between
    // the comparison and commit.
    if unsafe { SCPreferencesLock(preferences.as_concrete_TypeRef(), 0) } == 0 {
        return Err(NetworkDnsMutationFailure::Unchanged);
    }
    // SAFETY: refresh the live preferences snapshot after obtaining exclusivity so the comparison
    // observes the last value committed by any writer that held the lock before us.
    unsafe {
        SCPreferencesSynchronize(preferences.as_concrete_TypeRef());
    }
    let result = (|| {
        exact_service(
            &system_configuration_services(&preferences)
                .map_err(|_| NetworkDnsMutationFailure::Unchanged)?,
            service,
        )
        .map_err(|_| NetworkDnsMutationFailure::Unchanged)?;
        let protocol_type = CFString::new("DNS");
        for candidate in SCNetworkService::get_services(&preferences).into_iter() {
            if candidate.id().as_ref().map(ToString::to_string).as_deref() != Some(&service.id) {
                continue;
            }
            // SAFETY: the service belongs to the locked preferences session and "DNS" is fixed.
            let protocol = unsafe {
                SCNetworkServiceCopyProtocol(
                    candidate.as_concrete_TypeRef(),
                    protocol_type.as_concrete_TypeRef(),
                )
            };
            if protocol.is_null() {
                return Err(NetworkDnsMutationFailure::Unchanged);
            }
            let update = (|| {
                if protocol_dns_servers(protocol)
                    .map_err(|_| NetworkDnsMutationFailure::Unchanged)?
                    != expected
                {
                    return Err(NetworkDnsMutationFailure::Unchanged);
                }
                // SAFETY: the copied protocol remains live until explicitly released below.
                let configuration = unsafe { SCNetworkProtocolGetConfiguration(protocol) };
                let mut updated = if configuration.is_null() {
                    CFMutableDictionary::new()
                } else {
                    // SAFETY: GetConfiguration returned a borrowed dictionary owned by protocol.
                    let current = unsafe { CFDictionary::wrap_under_get_rule(configuration) };
                    CFMutableDictionary::from(&current)
                };
                // SAFETY: this process does not own the schema constant.
                let addresses_key =
                    unsafe { CFString::wrap_under_get_rule(kSCPropNetDNSServerAddresses) };
                if replacement.is_empty() {
                    updated.remove(addresses_key.to_void());
                } else {
                    let addresses = replacement
                        .iter()
                        .map(|address| CFString::new(&address.to_string()))
                        .collect::<Vec<_>>();
                    let addresses = CFArray::from_CFTypes(&addresses);
                    updated.set(
                        addresses_key.to_void(),
                        addresses.as_concrete_TypeRef().cast(),
                    );
                }
                // SAFETY: protocol and the updated dictionary remain live for this call.
                if unsafe {
                    SCNetworkProtocolSetConfiguration(
                        protocol,
                        updated.as_concrete_TypeRef().cast(),
                    )
                } == 0
                {
                    return Err(NetworkDnsMutationFailure::Unchanged);
                }
                // SAFETY: the live locked session owns the pending configuration update.
                if unsafe { SCPreferencesCommitChanges(preferences.as_concrete_TypeRef()) } == 0 {
                    return Err(NetworkDnsMutationFailure::MayHaveChanged);
                }
                // SAFETY: applying follows a successful commit on the same locked session.
                if unsafe { SCPreferencesApplyChanges(preferences.as_concrete_TypeRef()) } == 0 {
                    return Err(NetworkDnsMutationFailure::MayHaveChanged);
                }
                Ok(())
            })();
            // SAFETY: CopyProtocol returned an owned Core Foundation object.
            unsafe {
                system_configuration::core_foundation::base::CFRelease(protocol.cast());
            }
            return update;
        }
        Err(NetworkDnsMutationFailure::Unchanged)
    })();
    // SAFETY: this function obtained the exclusive lock above and releases it on every path.
    let unlocked = unsafe { SCPreferencesUnlock(preferences.as_concrete_TypeRef()) } != 0;
    result.and_then(|()| {
        unlocked
            .then_some(())
            .ok_or(NetworkDnsMutationFailure::MayHaveChanged)
    })
}

#[cfg(target_os = "macos")]
fn protocol_dns_servers(
    protocol: system_configuration::sys::network_configuration::SCNetworkProtocolRef,
) -> Result<Vec<IpAddr>, ()> {
    use std::ffi::c_void;

    use system_configuration::{
        core_foundation::{
            array::CFArray,
            base::{CFType, TCFType, ToVoid},
            dictionary::CFDictionary,
            string::CFString,
        },
        sys::{
            network_configuration::SCNetworkProtocolGetConfiguration,
            schema_definitions::kSCPropNetDNSServerAddresses,
        },
    };

    // SAFETY: callers provide a live DNS protocol reference.
    let configuration = unsafe { SCNetworkProtocolGetConfiguration(protocol) };
    if configuration.is_null() {
        return Ok(Vec::new());
    }
    // SAFETY: GetConfiguration returned a borrowed dictionary owned by the protocol.
    let configuration: CFDictionary<*const c_void, *const c_void> =
        unsafe { CFDictionary::wrap_under_get_rule(configuration) };
    let Some(addresses) = configuration
        // SAFETY: this process does not own the schema constant.
        .find(unsafe { kSCPropNetDNSServerAddresses }.to_void())
        .map(|pointer| {
            // SAFETY: the dictionary retains this value for the duration of the borrow.
            unsafe { CFType::wrap_under_get_rule(*pointer) }
        })
        .and_then(CFType::downcast_into::<CFArray>)
    else {
        return Ok(Vec::new());
    };
    if addresses.len() as usize > TUN_DNS_NAMESERVER_LIMIT {
        return Err(());
    }
    addresses
        .iter()
        .map(|pointer| {
            // SAFETY: the array retains this value for the duration of the iteration.
            unsafe { CFType::wrap_under_get_rule(*pointer) }
                .downcast_into::<CFString>()
                .ok_or(())?
                .to_string()
                .parse()
                .map_err(|_| ())
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
struct SystemConfigurationDnsSettings;

#[cfg(not(target_os = "macos"))]
impl NetworkDnsSettings for SystemConfigurationDnsSettings {
    fn observe<'a>(
        &'a self,
        _service: &'a ManagedNetworkService,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, ()>> {
        Box::pin(async { Err(()) })
    }

    fn compare_and_set<'a>(
        &'a self,
        _service: &'a ManagedNetworkService,
        _expected: &'a [IpAddr],
        _replacement: &'a [IpAddr],
    ) -> BoxFuture<'a, Result<(), NetworkDnsMutationFailure>> {
        Box::pin(async { Err(NetworkDnsMutationFailure::Unchanged) })
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
        replace_dns_before_compare_and_set: Mutex<Option<Vec<IpAddr>>>,
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
                _ => panic!("unexpected fixture command"),
            };
            Box::pin(ready(Ok(MacOsCommandOutput { stdout: output })))
        }
    }

    impl NetworkDnsSettings for FixtureRunner {
        fn observe<'a>(
            &'a self,
            service: &'a ManagedNetworkService,
        ) -> BoxFuture<'a, Result<Vec<IpAddr>, ()>> {
            Box::pin(async move {
                exact_service(&self.inventory_records.lock().unwrap(), service)?;
                Ok(self.dns.lock().unwrap().clone())
            })
        }

        fn compare_and_set<'a>(
            &'a self,
            service: &'a ManagedNetworkService,
            expected: &'a [IpAddr],
            replacement: &'a [IpAddr],
        ) -> BoxFuture<'a, Result<(), NetworkDnsMutationFailure>> {
            Box::pin(async move {
                exact_service(&self.inventory_records.lock().unwrap(), service)
                    .map_err(|_| NetworkDnsMutationFailure::Unchanged)?;
                if let Some(foreign) = self
                    .replace_dns_before_compare_and_set
                    .lock()
                    .unwrap()
                    .take()
                {
                    *self.dns.lock().unwrap() = foreign;
                }
                let mut dns = self.dns.lock().unwrap();
                if dns.as_slice() != expected {
                    return Err(NetworkDnsMutationFailure::Unchanged);
                }
                self.commands
                    .lock()
                    .unwrap()
                    .push(MacOsCommand::SetDnsServers {
                        servers: replacement.iter().map(IpAddr::to_string).collect(),
                        service: service.name.clone(),
                    });
                *dns = replacement.to_vec();
                drop(dns);
                if *self.replace_service_after_dns_write.lock().unwrap() {
                    self.inventory_records.lock().unwrap()[0].id = ETHERNET_ID.into();
                }
                let mut fail_after_dns_write = self.fail_after_dns_write.lock().unwrap();
                if *fail_after_dns_write {
                    *fail_after_dns_write = false;
                    return Err(NetworkDnsMutationFailure::MayHaveChanged);
                }
                Ok(())
            })
        }
    }

    struct WatchdogBeforeApplyController {
        dns: Mutex<Vec<IpAddr>>,
        journal: NetworkRecoveryJournal,
    }

    impl TunNetworkController for WatchdogBeforeApplyController {
        fn snapshot<'a>(
            &'a self,
            _system: &'a TunSystemSnapshot,
        ) -> BoxFuture<'a, Result<NetworkOwnershipSnapshot, ()>> {
            Box::pin(async { Err(()) })
        }

        fn apply<'a>(
            &'a self,
            snapshot: &'a NetworkOwnershipSnapshot,
            _system: &'a TunSystemSnapshot,
        ) -> BoxFuture<'a, Result<(), NetworkControllerApplyFailure>> {
            Box::pin(async move {
                assert!(
                    restore_network_transaction_if_recorded(self, &self.journal, &snapshot.dns,)
                        .await
                        .is_err()
                );
                *self.dns.lock().unwrap() = vec![MANAGED_DNS_ADDRESS];
                Ok(())
            })
        }

        fn restore<'a>(&'a self, state: &'a ManagedDnsState) -> BoxFuture<'a, Result<(), ()>> {
            Box::pin(async move {
                let mut dns = self.dns.lock().unwrap();
                if *dns == state.prior_servers {
                    return Ok(());
                }
                if *dns != [MANAGED_DNS_ADDRESS] {
                    return Err(());
                }
                *dns = state.prior_servers.clone();
                Ok(())
            })
        }

        fn observe<'a>(
            &'a self,
            _snapshot: &'a NetworkOwnershipSnapshot,
            _system: &'a TunSystemSnapshot,
            _dns_applied: bool,
        ) -> BoxFuture<'a, Result<NetworkOwnershipObservation, ()>> {
            Box::pin(async { Err(()) })
        }

        fn observe_recovery<'a>(
            &'a self,
            state: &'a ManagedDnsState,
        ) -> BoxFuture<'a, Result<TunObservationComponentState, ()>> {
            Box::pin(async move {
                let dns = self.dns.lock().unwrap();
                Ok(if *dns == state.prior_servers {
                    TunObservationComponentState::Confirmed
                } else if *dns == [MANAGED_DNS_ADDRESS] {
                    TunObservationComponentState::Partial
                } else {
                    TunObservationComponentState::Foreign
                })
            })
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
                port: Some(5353),
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
            replace_dns_before_compare_and_set: Mutex::new(None),
            replace_service_after_dns_write: Mutex::new(false),
            route_interfaces: Mutex::new(route_interfaces.into_iter().map(str::to_owned).collect()),
        });
        (
            MacOsTunNetworkController::with_dependencies(
                runner.clone(),
                inventory.clone(),
                runner.clone(),
            ),
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
        let restarted =
            MacOsTunNetworkController::with_dependencies(runner.clone(), inventory, runner.clone());
        restore_network_transaction(&restarted, &journal, &snapshot.dns)
            .await
            .unwrap();
        assert_eq!(*runner.dns.lock().unwrap(), prior);
        assert_eq!(journal.load().unwrap(), None);
    }

    #[tokio::test]
    async fn atomic_dns_compare_and_set_never_overwrites_a_racing_foreign_value() {
        let original = service(WIFI_ID, "Wi-Fi", "en0", EligibleNetworkKind::Wifi, 0);
        let prior = vec!["192.0.2.53".parse().unwrap()];
        let foreign = vec!["203.0.113.53".parse().unwrap()];
        let baseline = system("en0", "192.168.1.10");
        let (controller, _, runner) = fixture(vec![original.clone()], vec!["en0"], prior.clone());
        let snapshot = controller.snapshot(&baseline).await.unwrap();
        let (_directory, journal) = recovery_fixture();
        *runner.replace_dns_before_compare_and_set.lock().unwrap() = Some(foreign.clone());

        assert_eq!(
            apply_network_transaction(&controller, &journal, &snapshot, &baseline).await,
            Err(NetworkApplyFailure::Clean)
        );
        assert_eq!(*runner.dns.lock().unwrap(), foreign);
        assert_eq!(journal.load().unwrap(), None);

        let (controller, _, runner) =
            fixture(vec![original], vec!["en0"], vec![MANAGED_DNS_ADDRESS]);
        let (_directory, journal) = recovery_fixture();
        journal.persist(&snapshot.dns).unwrap();
        *runner.replace_dns_before_compare_and_set.lock().unwrap() = Some(foreign.clone());

        assert!(
            restore_network_transaction(&controller, &journal, &snapshot.dns)
                .await
                .is_err()
        );
        assert_eq!(*runner.dns.lock().unwrap(), foreign);
        assert_eq!(journal.load().unwrap(), Some(snapshot.dns));
    }

    #[tokio::test]
    async fn watchdog_cannot_consume_a_prepared_transaction_before_dns_apply() {
        let baseline = system("en0", "192.168.1.10");
        let snapshot = test_network_snapshot();
        let (_directory, journal) = recovery_fixture();
        let controller = WatchdogBeforeApplyController {
            dns: Mutex::new(snapshot.dns.prior_servers.clone()),
            journal: journal.clone(),
        };

        apply_network_transaction(&controller, &journal, &snapshot, &baseline)
            .await
            .unwrap();

        assert_eq!(*controller.dns.lock().unwrap(), vec![MANAGED_DNS_ADDRESS]);
        assert_eq!(
            journal.load_record().unwrap(),
            Some(NetworkRecoveryRecord {
                phase: NetworkRecoveryPhase::Applied,
                record_schema_version: NETWORK_RECOVERY_RECORD_VERSION,
                state: snapshot.dns.clone(),
            })
        );
        restore_network_transaction_if_recorded(&controller, &journal, &snapshot.dns)
            .await
            .unwrap();
        assert_eq!(*controller.dns.lock().unwrap(), snapshot.dns.prior_servers);
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
    async fn implicit_local_resolver_uses_the_physical_multicast_route() {
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
        baseline.dns_resolvers[0].interface = None;
        baseline.dns_resolvers[0].nameservers.clear();
        baseline.dns_resolvers[0].port = None;

        let snapshot = controller.snapshot(&baseline).await.unwrap();
        assert_eq!(
            controller
                .observe(&snapshot, &baseline, false)
                .await
                .unwrap()
                .routes,
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

    #[tokio::test]
    async fn transient_physical_neighbor_routes_do_not_join_the_owned_snapshot() {
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
            destination: "192.168.1.23".into(),
            flags: "UHLWIir".into(),
            gateway: "3c:22:fb:00:11:22".into(),
            interface: "en0".into(),
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
            transaction_id: "33333333-3333-4333-8333-333333333333".into(),
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
            transaction_id: "44444444-4444-4444-8444-444444444444".into(),
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

    #[test]
    fn removal_treats_a_missing_recovery_directory_as_already_absent() {
        let (directory, journal) = recovery_fixture();
        drop(directory);

        assert_eq!(journal.load_for_removal().unwrap(), None);
        assert!(journal.load().is_err());
    }

    #[tokio::test]
    async fn stale_watchdog_cannot_restore_or_clear_a_newer_transaction() {
        let (_directory, journal) = recovery_fixture();
        let (controller, _, runner) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["en0"],
            vec![MANAGED_DNS_ADDRESS],
        );
        let current = test_network_snapshot().dns;
        let mut stale = current.clone();
        stale.transaction_id = "55555555-5555-4555-8555-555555555555".into();
        journal.persist(&current).unwrap();

        assert!(
            restore_network_transaction_if_recorded(&controller, &journal, &stale)
                .await
                .is_err()
        );
        assert!(
            restore_network_transaction(&controller, &journal, &stale)
                .await
                .is_err()
        );
        assert_eq!(*runner.dns.lock().unwrap(), vec![MANAGED_DNS_ADDRESS]);
        assert_eq!(journal.load().unwrap(), Some(current.clone()));

        restore_network_transaction_if_recorded(&controller, &journal, &current)
            .await
            .unwrap();
        assert_eq!(
            *runner.dns.lock().unwrap(),
            vec!["192.0.2.53".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(journal.load().unwrap(), None);
    }

    #[tokio::test]
    async fn completed_watchdog_restoration_is_idempotent_for_helper_reap() {
        let (_directory, journal) = recovery_fixture();
        let (controller, _, runner) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["en0"],
            vec![MANAGED_DNS_ADDRESS],
        );
        let state = test_network_snapshot().dns;
        journal.persist(&state).unwrap();

        restore_network_transaction_if_recorded(&controller, &journal, &state)
            .await
            .unwrap();
        restore_network_transaction(&controller, &journal, &state)
            .await
            .unwrap();

        assert_eq!(
            *runner.dns.lock().unwrap(),
            vec!["192.0.2.53".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(journal.load().unwrap(), None);

        for unowned_dns in [
            vec![MANAGED_DNS_ADDRESS],
            vec!["203.0.113.53".parse::<IpAddr>().unwrap()],
        ] {
            *runner.dns.lock().unwrap() = unowned_dns.clone();
            assert!(
                restore_network_transaction(&controller, &journal, &state)
                    .await
                    .is_err()
            );
            assert_eq!(*runner.dns.lock().unwrap(), unowned_dns);
        }
    }

    #[tokio::test]
    async fn simultaneous_watchdog_and_helper_restoration_is_idempotent() {
        let (_directory, journal) = recovery_fixture();
        let (controller, _, runner) = fixture(
            vec![service(
                WIFI_ID,
                "Wi-Fi",
                "en0",
                EligibleNetworkKind::Wifi,
                0,
            )],
            vec!["en0"],
            vec![MANAGED_DNS_ADDRESS],
        );
        let state = test_network_snapshot().dns;
        journal.persist(&state).unwrap();
        *runner.replace_dns_before_compare_and_set.lock().unwrap() =
            Some(state.prior_servers.clone());

        restore_network_transaction(&controller, &journal, &state)
            .await
            .unwrap();

        assert_eq!(*runner.dns.lock().unwrap(), state.prior_servers);
        assert_eq!(journal.load().unwrap(), None);
    }
}

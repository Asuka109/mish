use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::{MobileVpnSnapshot, Result};

#[derive(Clone)]
pub struct MishVpn<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime>(app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<MishVpn<R>> {
    Ok(MishVpn(app.clone()))
}

impl<R: Runtime> MishVpn<R> {
    pub fn get_snapshot(&self) -> Result<MobileVpnSnapshot> {
        Ok(MobileVpnSnapshot::unsupported())
    }

    pub fn request_notification_permission(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn request_vpn_consent(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn start_fixture_lifecycle(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn stop(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }
}

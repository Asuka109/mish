use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSnapshotOrder {
    pub authority_id: String,
    pub epoch: u64,
    pub order: u64,
}

impl ApplicationSnapshotOrder {
    pub fn detached() -> Self {
        Self {
            authority_id: "detached".into(),
            epoch: 0,
            order: 0,
        }
    }
}

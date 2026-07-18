use std::fmt;

use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Endpoint {
    Version,
    Configs,
    Proxies,
    Traffic,
    Memory,
    Connections,
    Rules,
}

impl Endpoint {
    pub const fn path(self) -> &'static str {
        match self {
            Self::Version => "/version",
            Self::Configs => "/configs",
            Self::Proxies => "/proxies",
            Self::Traffic => "/traffic",
            Self::Memory => "/memory",
            Self::Connections => "/connections",
            Self::Rules => "/rules",
        }
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.path())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControllerErrorKind {
    InvalidConfiguration,
    Shutdown,
    Timeout,
    Transport,
    HttpStatus,
    BodyTooLarge,
    MessageTooLarge,
    Decode,
    Validation,
    UnsupportedVersion,
    StreamEnded,
}

#[derive(Debug, Error)]
pub enum ControllerError {
    #[error("invalid controller client configuration: {detail}")]
    InvalidConfiguration { detail: String },
    #[error("controller client shut down while reading {endpoint}")]
    Shutdown { endpoint: Endpoint },
    #[error("controller request to {endpoint} timed out")]
    Timeout { endpoint: Endpoint },
    #[error("controller transport failed for {endpoint}: {detail}")]
    Transport { endpoint: Endpoint, detail: String },
    #[error("controller returned HTTP {status} for {endpoint}")]
    HttpStatus { endpoint: Endpoint, status: u16 },
    #[error("controller body for {endpoint} exceeded {limit} bytes")]
    BodyTooLarge { endpoint: Endpoint, limit: usize },
    #[error("controller message for {endpoint} exceeded {limit} bytes")]
    MessageTooLarge { endpoint: Endpoint, limit: usize },
    #[error("controller response for {endpoint} could not be decoded: {detail}")]
    Decode { endpoint: Endpoint, detail: String },
    #[error("controller response for {endpoint} failed validation at {field}: {detail}")]
    Validation {
        endpoint: Endpoint,
        field: &'static str,
        detail: String,
    },
    #[error("controller version {received} is unsupported; expected {expected}")]
    UnsupportedVersion {
        expected: &'static str,
        received: String,
    },
    #[error("controller stream for {endpoint} ended before its first snapshot")]
    StreamEnded { endpoint: Endpoint },
}

impl ControllerError {
    pub const fn kind(&self) -> ControllerErrorKind {
        match self {
            Self::InvalidConfiguration { .. } => ControllerErrorKind::InvalidConfiguration,
            Self::Shutdown { .. } => ControllerErrorKind::Shutdown,
            Self::Timeout { .. } => ControllerErrorKind::Timeout,
            Self::Transport { .. } => ControllerErrorKind::Transport,
            Self::HttpStatus { .. } => ControllerErrorKind::HttpStatus,
            Self::BodyTooLarge { .. } => ControllerErrorKind::BodyTooLarge,
            Self::MessageTooLarge { .. } => ControllerErrorKind::MessageTooLarge,
            Self::Decode { .. } => ControllerErrorKind::Decode,
            Self::Validation { .. } => ControllerErrorKind::Validation,
            Self::UnsupportedVersion { .. } => ControllerErrorKind::UnsupportedVersion,
            Self::StreamEnded { .. } => ControllerErrorKind::StreamEnded,
        }
    }

    pub fn transport(endpoint: Endpoint, detail: impl Into<String>) -> Self {
        Self::Transport {
            endpoint,
            detail: detail.into(),
        }
    }
}

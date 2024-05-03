//! Library code for the Jute application.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::io;

pub mod jupyter_client;
pub mod server;
pub mod wire_protocol;

/// A serializable error type for application errors.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An error occurred while starting a subprocess.
    #[error("subprocess failed to start: {0}")]
    Subprocess(io::Error),

    /// Could not connect to the kernel.
    #[error("could not connect to the kernel: {0}")]
    KernelConnect(String),

    /// Disconnected while communicating with a kernel.
    #[error("disconnected from the kernel")]
    KernelDisconnect,

    /// An invalid URL was provided or constructed.
    #[error("invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),

    /// HTTP error from reqwest while making a request.
    #[error("HTTP failure: {0}")]
    ReqwestError(#[from] reqwest::Error),

    /// Error originating from ZeroMQ.
    #[error("zeromq: {0}")]
    Zmq(#[from] zeromq::ZmqError),
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

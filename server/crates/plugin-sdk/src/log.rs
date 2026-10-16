//! `log` import plus `info!`-style macros.

pub use crate::bindings::fliks::plugin::log::Level;

pub fn log(level: Level, message: &str) {
    crate::bindings::fliks::plugin::log::log(level, message);
}

#[macro_export]
macro_rules! info {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Info, &format!($($t)*)) };
}
#[macro_export]
macro_rules! warn {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Warn, &format!($($t)*)) };
}
#[macro_export]
macro_rules! error {
    ($($t:tt)*) => { $crate::log::log($crate::log::Level::Error, &format!($($t)*)) };
}

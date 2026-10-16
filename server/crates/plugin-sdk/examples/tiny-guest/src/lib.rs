//! Smallest guest: every export at its SDK default.

struct Tiny;
impl fliks_plugin_sdk::Plugin for Tiny {}
fliks_plugin_sdk::export!(Tiny);

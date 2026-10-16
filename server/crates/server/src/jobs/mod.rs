//! The scheduler (`docs/spec/scheduler.md`): `commands` rows, cron runner, core jobs, /api/commands*.
//! Other domains audit work through `run_audited` and plug their bodies in through `JobWork`.
mod audit;
mod bodies;
mod cron;
mod names;
mod routes;
mod runner;
mod work;

pub use audit::{Trigger, any_active, run_audited, sweep};
pub use cron::server_tz;
pub use routes::{
    __path_clear_history, __path_list, __path_schedulers, __path_trigger, clear_history, list,
    router, schedulers, trigger,
};
pub use runner::{Claim, Running, spawn};
pub use work::{JobWork, Rescan, SeasonScan, Unwired, Work, WorkError};

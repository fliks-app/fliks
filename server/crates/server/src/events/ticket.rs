//! Single-use tickets that open `GET /api/system/events` in place of a bearer token in the URL.
use crate::sync::MutexExt;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TTL: Duration = Duration::from_secs(30);
const MAX_TICKETS: usize = 10_000;

#[derive(Default)]
pub struct Tickets {
    open: Mutex<HashMap<String, (i32, Instant)>>,
}

impl Tickets {
    pub fn mint(&self, user_id: i32) -> String {
        let mut buf = [0u8; 24];
        getrandom::fill(&mut buf).expect("os rng");
        let ticket = URL_SAFE_NO_PAD.encode(buf);
        let mut m = self.open.lock_clean();
        if m.len() >= MAX_TICKETS {
            m.retain(|_, (_, at)| at.elapsed() < TTL);
            // ponytail: a flood of mints drops every pending ticket, per-user caps if that matters
            if m.len() >= MAX_TICKETS {
                m.clear();
            }
        }
        m.insert(ticket.clone(), (user_id, Instant::now()));
        ticket
    }

    /// Removes the ticket whatever happens: a second use, or one past `TTL`, finds nothing.
    pub fn redeem(&self, ticket: &str) -> Option<i32> {
        let (user_id, at) = self.open.lock_clean().remove(ticket)?;
        (at.elapsed() < TTL).then_some(user_id)
    }

    #[cfg(test)]
    fn age(&self, ticket: &str, by: Duration) {
        if let Some((_, at)) = self.open.lock_clean().get_mut(ticket) {
            *at -= by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_works_once() {
        let t = Tickets::default();
        let a = t.mint(7);
        assert_eq!(t.redeem(&a), Some(7));
        assert_eq!(t.redeem(&a), None);
        assert_eq!(t.redeem("nope"), None);
    }

    #[test]
    fn a_ticket_expires_and_stays_gone() {
        let t = Tickets::default();
        let a = t.mint(7);
        t.age(&a, TTL);
        assert_eq!(t.redeem(&a), None);
        assert!(t.open.lock_clean().is_empty());
    }

    #[test]
    fn tickets_are_distinct_per_mint() {
        let t = Tickets::default();
        assert_ne!(t.mint(1), t.mint(1));
    }
}

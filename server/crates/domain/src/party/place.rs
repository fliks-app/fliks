//! Where a row added to a party's programme goes (`docs/spec/watch-party.md`, Programme).
use serde::Deserialize;
use std::collections::HashMap;

/// Where the host puts a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Where {
    Next,
    Last,
}

/// How an addition is placed: where it was asked for, or by turns with a cap on upcoming rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    At(Where),
    Turns { cap: usize },
}

/// The author already has `cap` upcoming rows.
#[derive(Debug, PartialEq, Eq)]
pub struct Full;

/// The index where a row by `author` is inserted into a programme whose rows were added by
/// `authors`. `current` is the row playing (the head before the start, `started` false: nothing
/// has played yet, so no author has a last turn).
pub fn place(
    authors: &[Option<i32>],
    current: Option<usize>,
    started: bool,
    author: Option<i32>,
    rule: Rule,
) -> Result<usize, Full> {
    let start = current.map_or(0, |c| c + 1);
    let cap = match rule {
        Rule::At(Where::Next) => return Ok(start),
        Rule::At(Where::Last) => return Ok(authors.len()),
        Rule::Turns { cap } => cap,
    };
    let played = if started { current.unwrap_or(0) } else { 0 };
    let mut last: HashMap<Option<i32>, usize> = HashMap::new();
    for (i, a) in authors[..played].iter().enumerate() {
        last.insert(*a, i);
    }
    let upcoming = &authors[start..];
    // Each row's key: its author's turn number, then who sang last longest ago (never first), then
    // who has waited longest, then its place.
    let mut seen: HashMap<Option<i32>, (usize, usize)> = HashMap::new();
    let keys: Vec<_> = upcoming
        .iter()
        .enumerate()
        .map(|(j, a)| {
            let (n, first) = seen.entry(*a).or_insert((0, j));
            let key = (*n, last.get(a).copied(), *first, j);
            *n += 1;
            key
        })
        .collect();
    let (turn, first) = seen.get(&author).copied().unwrap_or((0, usize::MAX));
    if turn >= cap {
        return Err(Full);
    }
    let mine = (turn, last.get(&author).copied(), first, usize::MAX);
    let at = keys
        .iter()
        .position(|k| *k > mine)
        .unwrap_or(upcoming.len());
    Ok(start + at)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Option<i32> = Some(10);
    const B: Option<i32> = Some(20);
    const C: Option<i32> = Some(30);

    /// Adds `(id, author)` rows one by one under `Turns` after the played rows and the playing one.
    fn queue(played: &[Option<i32>], adds: &[(i32, Option<i32>)], cap: usize) -> Vec<i32> {
        let mut authors: Vec<Option<i32>> = played.to_vec();
        authors.push(Some(99));
        let mut ids: Vec<i32> = vec![0; authors.len()];
        let current = Some(played.len());
        for &(id, who) in adds {
            let at = place(&authors, current, true, who, Rule::Turns { cap }).unwrap();
            authors.insert(at, who);
            ids.insert(at, id);
        }
        ids[played.len() + 1..].to_vec()
    }

    #[test]
    fn rounds_go_singer_by_singer_the_least_recent_first() {
        // a: 1 2 3, b: 4, c: 5 6; b sang earlier, c last, a never.
        let adds = [(1, A), (2, A), (3, A), (4, B), (5, C), (6, C)];
        assert_eq!(queue(&[B, C], &adds, 9), [1, 4, 5, 2, 6, 3]);
        // nobody has sung: the one who waited longest first.
        assert_eq!(queue(&[], &adds, 9), [1, 4, 5, 2, 6, 3]);
        let late = [(1, A), (2, B), (3, A)];
        assert_eq!(queue(&[A], &late, 9), [2, 1, 3]);
    }

    #[test]
    fn the_cap_counts_upcoming_rows_only() {
        let rows = [A, B, A];
        assert_eq!(
            place(&rows, Some(0), true, A, Rule::Turns { cap: 1 }),
            Err(Full)
        );
        // a's first row is the one playing: it no longer counts.
        assert_eq!(
            place(&[A, B], Some(0), true, A, Rule::Turns { cap: 1 }),
            Ok(2)
        );
        assert_eq!(
            place(&[A, B, A], Some(0), true, A, Rule::Turns { cap: 2 }),
            Ok(3)
        );
    }

    #[test]
    fn next_and_last_follow_the_playing_row_or_the_end() {
        let rows = [A, B, C];
        let next = Rule::At(Where::Next);
        assert_eq!(place(&rows, Some(1), true, A, next), Ok(2));
        assert_eq!(place(&rows, Some(0), false, A, next), Ok(1));
        assert_eq!(place(&[], None, false, A, next), Ok(0));
        assert_eq!(place(&rows, None, true, A, next), Ok(0));
        assert_eq!(place(&rows, Some(0), true, A, Rule::At(Where::Last)), Ok(3));
    }

    #[test]
    fn before_the_start_no_one_has_a_last_turn() {
        // Head a; b then c add: a's head is not upcoming, nobody has played.
        let mut authors = vec![A];
        for who in [B, C, B] {
            let at = place(&authors, Some(0), false, who, Rule::Turns { cap: 9 }).unwrap();
            authors.insert(at, who);
        }
        assert_eq!(authors, [A, B, C, B]);
    }
}

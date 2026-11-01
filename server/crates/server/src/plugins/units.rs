//! `unit-ref` on video: a group and an item are whole numbers (`plugins.md` rule 31).
use super::imports::host_err;
use super::runtime::{HostError, fliks::plugin::types as t};

fn whole(n: f64, what: &str) -> Result<u32, HostError> {
    if n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n) {
        Ok(n as u32)
    } else {
        Err(host_err(
            "ERR_VALIDATION",
            format!("unit {what} {n} is not a whole number"),
        ))
    }
}

/// The season and episode numbers a unit names; an item needs its group.
pub fn video(u: Option<&t::UnitRef>) -> Result<(Option<u32>, Option<u32>), HostError> {
    let Some(u) = u else {
        return Ok((None, None));
    };
    u.end_number.map(|n| whole(n, "end-number")).transpose()?;
    let number = u.number.map(|n| whole(n, "number")).transpose()?;
    if number.is_some() && u.group.is_none() {
        return Err(host_err("ERR_VALIDATION", "a unit number needs its group"));
    }
    Ok((u.group, number))
}

/// The unit of a season and an episode; none is the whole work.
pub fn unit_ref(group: Option<i32>, number: Option<i32>) -> Option<t::UnitRef> {
    (group.is_some() || number.is_some()).then(|| t::UnitRef {
        group: group.map(|g| g as u32),
        number: number.map(f64::from),
        end_number: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(group: Option<u32>, number: Option<f64>) -> t::UnitRef {
        t::UnitRef {
            group,
            number,
            end_number: None,
        }
    }

    #[test]
    fn video_units_are_whole_and_grouped() {
        assert_eq!(video(None).unwrap(), (None, None));
        assert_eq!(video(Some(&unit(Some(2), None))).unwrap(), (Some(2), None));
        assert_eq!(
            video(Some(&unit(Some(2), Some(5.0)))).unwrap(),
            (Some(2), Some(5))
        );
        for bad in [unit(Some(1), Some(1.5)), unit(None, Some(3.0))] {
            assert_eq!(video(Some(&bad)).unwrap_err().code, "ERR_VALIDATION");
        }
        let end = t::UnitRef {
            end_number: Some(0.5),
            ..unit(Some(1), Some(1.0))
        };
        assert!(video(Some(&end)).is_err());
    }

    #[test]
    fn unit_ref_of_a_whole_work_is_none() {
        assert!(unit_ref(None, None).is_none());
        let u = unit_ref(Some(1), Some(2)).unwrap();
        assert_eq!((u.group, u.number), (Some(1), Some(2.0)));
    }
}

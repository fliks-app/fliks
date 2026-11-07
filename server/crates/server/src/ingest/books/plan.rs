//! The works of a scan, one per folder or file (`docs/spec/ingest.md`). Pure.
use super::group::{self, Work};
use fliks_domain::books::filename::parse_path;
use std::collections::HashSet;

/// A work with files still to take, and whether its folder anchors it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub name_path: String,
    pub anchor: Option<String>,
    pub title: String,
    pub year: Option<i32>,
    pub files: Vec<String>,
}

/// `owner(rel)` is the folder name of the media that links `rel`, `None` when none does.
pub fn plan(rels: &[String], owner: impl Fn(&str) -> Option<String>) -> Vec<Planned> {
    // A folder that already has a linked file keeps the grouping of its media: no split.
    let linked: HashSet<String> = rels
        .iter()
        .filter(|r| owner(r).is_some())
        .map(|r| group::work_dir(r))
        .collect();
    let (old, new): (Vec<String>, Vec<String>) = rels
        .iter()
        .cloned()
        .partition(|r| linked.contains(&group::work_dir(r)));
    let mut works = group::group(&new);
    works.extend(group::group_whole(&old));
    works.sort_by(|a, b| (&a.dir, &a.name_path).cmp(&(&b.dir, &b.name_path)));
    works
        .iter()
        .enumerate()
        .filter_map(|(i, w)| {
            let all: Vec<&String> = w.versions.iter().flat_map(|v| &v.files).collect();
            let files: Vec<String> = all
                .iter()
                .filter(|r| owner(r).is_none())
                .map(|r| (*r).clone())
                .collect();
            if files.is_empty() {
                return None;
            }
            let guess = parse_path(&w.name_path);
            Some(Planned {
                anchor: anchor(&works, i, &all, &owner),
                title: guess
                    .title
                    .unwrap_or_else(|| w.dir.rsplit('/').next().unwrap_or_default().to_owned()),
                year: guess.year,
                name_path: w.name_path.clone(),
                files,
            })
        })
        .collect()
}

/// `book-ingest.md` rule 10: the work is alone in its folder and its linked files agree.
fn anchor(
    works: &[Work],
    i: usize,
    all: &[&String],
    owner: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let dir = &works[i].dir;
    let below = format!("{dir}/");
    let alone = !works
        .iter()
        .enumerate()
        .any(|(j, o)| j != i && (o.dir == *dir || o.dir.starts_with(&below)));
    let agree = all.iter().filter_map(|r| owner(r)).all(|o| o == *dir);
    (!dir.is_empty() && alone && agree).then(|| dir.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rels(r: &[&str]) -> Vec<String> {
        r.iter().map(|s| (*s).to_owned()).collect()
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_work_alone_in_its_folder_is_anchored_at_any_depth() {
        let p = plan(
            &rels(&["Una Roe/Cycle/Alpha/Alpha.epub", "Una Roe/Beta/Beta.epub"]),
            none,
        );
        let anchors: Vec<_> = p.iter().map(|w| w.anchor.as_deref()).collect();
        assert_eq!(anchors, [Some("Una Roe/Beta"), Some("Una Roe/Cycle/Alpha")]);
    }

    #[test]
    fn a_loose_file_and_several_works_of_one_folder_have_no_anchor() {
        let p = plan(
            &rels(&["Loose.epub", "Shelf/One.epub", "Shelf/Two.epub"]),
            none,
        );
        assert_eq!(p.len(), 3);
        assert!(p.iter().all(|w| w.anchor.is_none()));
    }

    #[test]
    fn a_work_above_another_is_not_anchored() {
        let p = plan(&rels(&["A/Alpha.epub", "A/B/Beta.epub"]), none);
        let by = |n: &str| p.iter().find(|w| w.files[0].ends_with(n)).unwrap();
        assert_eq!(by("Alpha.epub").anchor, None);
        assert_eq!(by("Beta.epub").anchor.as_deref(), Some("A/B"));
    }

    #[test]
    fn a_file_another_media_owns_is_never_planned() {
        let owner = |r: &str| (r == "Alpha/Alpha.epub").then(|| "Elsewhere".to_owned());
        let p = plan(&rels(&["Alpha/Alpha.epub", "Beta/Beta.epub"]), owner);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].files, ["Beta/Beta.epub"]);
        // a work with a linked file of another folder is planned for its free files, unanchored
        let owner = |r: &str| (r == "Gamma/Gamma.epub").then(|| "Elsewhere".to_owned());
        let p = plan(&rels(&["Gamma/Gamma.epub", "Gamma/Gamma.pdf"]), owner);
        assert_eq!(
            (p[0].files.clone(), p[0].anchor.clone()),
            (rels(&["Gamma/Gamma.pdf"]), None)
        );
    }

    #[test]
    fn a_linked_work_of_the_same_folder_keeps_its_anchor() {
        let owner = |r: &str| (r == "Gamma/Gamma.epub").then(|| "Gamma".to_owned());
        let p = plan(&rels(&["Gamma/Gamma.epub", "Gamma/Gamma.pdf"]), owner);
        assert_eq!(p[0].anchor.as_deref(), Some("Gamma"));
    }

    #[test]
    fn a_folder_with_a_linked_file_is_not_split() {
        let files = [
            "F/A - 01.mp3",
            "F/A - 02.mp3",
            "F/B - 01.mp3",
            "F/B - 02.mp3",
        ];
        assert_eq!(plan(&rels(&files), none).len(), 2);
        let owner = |r: &str| (r == "F/A - 01.mp3").then(|| "F".to_owned());
        let p = plan(&rels(&files), owner);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].files.len(), 3);
    }

    #[test]
    fn a_fully_linked_work_is_not_planned() {
        let owner = |_: &str| Some(String::new());
        assert!(plan(&rels(&["Alpha/Alpha.epub"]), owner).is_empty());
    }
}

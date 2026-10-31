//! The listing of the companion files of one media file (rules 83-85).
use super::*;
use fliks_domain::media::kind::MediaKind;

/// Rules 83-85.
pub(super) fn scan(
    root: &fsx::Root,
    mdir: &Path,
    kind: MediaKind,
    own_folder: bool,
    files: &[FileRow],
    pos: usize,
    rows: &[SubRow],
) -> Vec<Companion> {
    let file = &files[pos];
    let Some(rel) = fsx::safe_rel(&file.rel) else {
        return vec![];
    };
    let video = mdir.join(rel);
    let dir = video.parent().unwrap_or(mdir).to_path_buf();
    if !root.contains(&dir, true) {
        return vec![];
    }
    let stem = stem_l(&file.rel);
    let dir_of = |f: &FileRow| {
        fsx::safe_rel(&f.rel).and_then(|r| mdir.join(r).parent().map(Path::to_path_buf))
    };
    let siblings: Vec<&FileRow> = files
        .iter()
        .filter(|f| f.id != file.id && dir_of(f).as_ref() == Some(&dir) && stem_l(&f.rel) == stem)
        .collect();
    let mut by_path: BTreeMap<String, Vec<&SubRow>> = BTreeMap::new();
    for r in rows {
        by_path.entry(norm(&r.rel)).or_default().push(r);
    }
    let mut c = Collector {
        mdir,
        file,
        files,
        siblings: &siblings,
        out: vec![],
    };
    if own_folder {
        c.folder_companions(&dir, kind);
    }
    c.row_subtitles(&by_path);
    let media_files: Vec<(&str, bool)> = files
        .iter()
        .map(|f| (f.rel.as_str(), dir_of(f).as_ref() == Some(&dir)))
        .collect();
    let names = regular_files(&dir);
    let longer: Vec<String> = names
        .iter()
        .filter(|n| is_video(n))
        .map(|n| split_ext(n).0.to_lowercase())
        .filter(|s| s.len() > stem.len() && s.starts_with(&format!("{stem}.")))
        .collect();
    let claimed = |lower: &str| longer.iter().any(|s| lower.starts_with(&format!("{s}.")));
    let idx = c.sidecars(
        &dir,
        &names,
        &Sidecar {
            stem: &stem,
            kind,
            own_folder,
            by_path: &by_path,
            media_files: &media_files,
            claimed: &claimed,
        },
    );
    c.pair_idx(&dir, idx, &stem, &claimed);
    let mut out = c.out;
    out.sort_by(|a, b| {
        (a.scope != "file", a.name.to_lowercase(), &a.name).cmp(&(
            b.scope != "file",
            b.name.to_lowercase(),
            &b.name,
        ))
    });
    out
}

pub(super) struct Collector<'a> {
    mdir: &'a Path,
    file: &'a FileRow,
    files: &'a [FileRow],
    siblings: &'a [&'a FileRow],
    out: Vec<Companion>,
}

pub(super) struct Sidecar<'a> {
    stem: &'a str,
    kind: MediaKind,
    own_folder: bool,
    by_path: &'a BTreeMap<String, Vec<&'a SubRow>>,
    media_files: &'a [(&'a str, bool)],
    claimed: &'a dyn Fn(&str) -> bool,
}

impl Collector<'_> {
    fn name_of(&self, id: i32) -> String {
        self.files
            .iter()
            .find(|f| f.id == id)
            .map_or(format!("#{id}"), |f| base_name(&f.rel))
    }

    fn add(
        &mut self,
        abs_dir: &Path,
        name: &str,
        scope: &'static str,
        kind: &'static str,
        sub_rows: &[&SubRow],
    ) {
        let file = self.file;
        let abs = abs_dir.join(name);
        let Some(rel) = fsx::rel_under(self.mdir, &abs) else {
            return;
        };
        let rel = norm(&rel);
        if self.out.iter().any(|c| c.relative_path == rel) {
            return;
        }
        let Ok(meta) = fs::symlink_metadata(&abs) else {
            return;
        };
        if !meta.is_file() {
            return;
        }
        let own = sub_rows
            .iter()
            .find(|r| r.file_id == Some(file.id))
            .or(sub_rows.first());
        let parsed = (kind == "subtitle")
            .then(|| parse_subtitle_filename(name))
            .flatten();
        let mut shared: Vec<Shared> = vec![];
        if scope == "file" {
            for r in sub_rows.iter().filter(|r| r.file_id != Some(file.id)) {
                if let Some(id) = r.file_id
                    && !shared.iter().any(|s| s.file_id == id)
                {
                    shared.push(Shared {
                        file_id: id,
                        name: self.name_of(id),
                    });
                }
            }
            if sub_rows.is_empty() {
                for f in self.siblings {
                    shared.push(Shared {
                        file_id: f.id,
                        name: base_name(&f.rel),
                    });
                }
            }
        }
        let mtime = meta
            .modified()
            .map(|t| fliks_domain::js::iso(DateTime::<Utc>::from(t)))
            .unwrap_or_default();
        self.out.push(Companion {
            name: name.to_owned(),
            relative_path: rel,
            size: meta.len(),
            mtime,
            kind,
            scope,
            subtitle: match (own, parsed) {
                (Some(r), _) => Some(SubtitleInfo {
                    id: Some(r.id),
                    language: r.language.clone(),
                    forced: r.forced,
                    hearing_impaired: r.hi,
                }),
                (None, Some(p)) => Some(SubtitleInfo {
                    id: None,
                    language: p.language,
                    forced: p.forced,
                    hearing_impaired: p.hearing_impaired,
                }),
                _ => None,
            },
            shared_with: shared,
            has_pair: false,
        });
    }

    /// The `.nfo` and the artwork of a media folder.
    fn folder_companions(&mut self, dir: &Path, kind: MediaKind) {
        let mdir = self.mdir;
        let parent = dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dir.to_path_buf());
        let (nfo, art): (Vec<(PathBuf, &str)>, PathBuf) = match kind {
            MediaKind::Series => (
                vec![
                    (mdir.to_path_buf(), "tvshow.nfo"),
                    (dir.to_path_buf(), "tvshow.nfo"),
                    (parent, "tvshow.nfo"),
                ],
                mdir.to_path_buf(),
            ),
            MediaKind::Movie => (vec![(dir.to_path_buf(), "movie.nfo")], dir.to_path_buf()),
        };
        for (d, want) in nfo {
            if !d.starts_with(mdir) {
                continue;
            }
            if let Some(hit) = regular_files(&d)
                .into_iter()
                .find(|n| n.to_lowercase() == want)
            {
                self.add(&d, &hit, "folder", "nfo", &[]);
            }
        }
        for n in regular_files(&art) {
            let (s, e) = split_ext(&n);
            if IMAGE_EXTS.contains(&e.to_lowercase().as_str())
                && FOLDER_ART.contains(&s.to_lowercase().as_str())
            {
                self.add(&art, &n, "folder", "image", &[]);
            }
        }
    }

    /// The subtitle files a row points at, for this file or one of its siblings.
    fn row_subtitles(&mut self, by_path: &BTreeMap<String, Vec<&SubRow>>) {
        let (file, mdir) = (self.file, self.mdir);
        for (rel, rs) in by_path {
            if !rs.iter().any(|r| {
                r.file_id == Some(file.id)
                    || r.file_id
                        .is_some_and(|f| self.siblings.iter().any(|s| s.id == f))
            }) {
                continue;
            }
            if let Some(abs) = fsx::safe_rel(rel).map(|r| mdir.join(r))
                && let (Some(d), Some(n)) = (abs.parent(), abs.file_name())
            {
                self.add(d, &n.to_string_lossy(), "file", "subtitle", rs);
            }
        }
    }

    /// Files named after the video; returns the `.idx` names, paired with their `.sub` afterwards.
    fn sidecars(&mut self, dir: &Path, names: &[String], x: &Sidecar) -> Vec<String> {
        let (file, mdir, stem) = (self.file, self.mdir, x.stem);
        let mut idx = vec![];
        for name in names {
            let lower = name.to_lowercase();
            let (base, ext) = split_ext(&lower);
            if is_video(name) {
                continue;
            }
            if ext == ".idx" {
                idx.push(name.clone());
            } else if lower == format!("{stem}.edl") {
                self.add(dir, name, "file", "edl", &[]);
            } else if lower == format!("{stem}.nfo") {
                self.add(dir, name, "file", "nfo", &[]);
            } else if x.kind == MediaKind::Movie
                && IMAGE_EXTS.contains(&ext)
                && (base == format!("{stem}-poster") || base == format!("{stem}-fanart"))
            {
                self.add(dir, name, "file", "image", &[]);
            } else if parse_subtitle_filename(name).is_some() {
                let rel = fsx::rel_under(mdir, &dir.join(name))
                    .map(|r| norm(&r))
                    .unwrap_or_default();
                if x.by_path.contains_key(&rel) || (x.claimed)(&lower) {
                    continue;
                }
                let hit = match_subtitle_video(name, x.media_files, x.own_folder)
                    .map(|i| self.files[i].id);
                if hit.is_some_and(|h| h == file.id || self.siblings.iter().any(|s| s.id == h)) {
                    self.add(dir, name, "file", "subtitle", &[]);
                }
            } else if lower.starts_with(&format!("{stem}.")) && !(x.claimed)(&lower) {
                self.add(dir, name, "file", "other", &[]);
            }
        }
        idx
    }

    fn pair_idx(
        &mut self,
        dir: &Path,
        idx: Vec<String>,
        stem: &str,
        claimed: &dyn Fn(&str) -> bool,
    ) {
        for name in idx {
            let Some(rel) = fsx::rel_under(self.mdir, &dir.join(&name)).map(|r| norm(&r)) else {
                continue;
            };
            let base = rel[..rel.len() - ".idx".len()].to_lowercase();
            let pair = self.out.iter().position(|c| {
                c.kind == "subtitle" && c.relative_path.to_lowercase() == format!("{base}.sub")
            });
            if let Some(p) = pair {
                self.add(dir, &name, "file", "subtitle", &[]);
                let shared = self.out[p].shared_with.clone();
                if let Some(m) = self.out.iter().position(|c| c.relative_path == rel) {
                    self.out[m].subtitle = None;
                    self.out[m].shared_with = shared;
                    self.out[m].has_pair = true;
                    self.out[p].has_pair = true;
                }
            } else if name.to_lowercase().starts_with(&format!("{stem}."))
                && !claimed(&name.to_lowercase())
            {
                self.add(dir, &name, "file", "other", &[]);
            }
        }
    }
}

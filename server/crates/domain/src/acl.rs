//! Permission matrix, a port of `casl-ability.factory.ts` (`docs/spec/auth.md` rules 19-26).
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Manage,
    Create,
    Read,
    Update,
    Delete,
    Approve,
    Decline,
    Grab,
    Track,
}

impl FromStr for Action {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "manage" => Self::Manage,
            "create" => Self::Create,
            "read" => Self::Read,
            "update" => Self::Update,
            "delete" => Self::Delete,
            "approve" => Self::Approve,
            "decline" => Self::Decline,
            "grab" => Self::Grab,
            "track" => Self::Track,
            _ => return Err(()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Subject {
    User,
    Media,
    FliksRequest,
    QualityProfile,
    LanguageProfile,
    SubtitleProvider,
    SubtitleFile,
    TranslationProvider,
    Library,
    Playlist,
    LiveTvChannel,
    Role,
    Settings,
    All,
    /// `plugin:<id>:<name>`, stored whole.
    Plugin(String),
}

impl FromStr for Subject {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "User" => Self::User,
            "Media" => Self::Media,
            "FliksRequest" => Self::FliksRequest,
            "QualityProfile" => Self::QualityProfile,
            "LanguageProfile" => Self::LanguageProfile,
            "SubtitleProvider" => Self::SubtitleProvider,
            "SubtitleFile" => Self::SubtitleFile,
            "TranslationProvider" => Self::TranslationProvider,
            "Library" => Self::Library,
            "Playlist" => Self::Playlist,
            "LiveTvChannel" => Self::LiveTvChannel,
            "Role" => Self::Role,
            "Settings" => Self::Settings,
            "all" => Self::All,
            _ if is_plugin_subject(s) => Self::Plugin(s.to_owned()),
            _ => return Err(()),
        })
    }
}

const PLUGIN_PREFIX: &str = "plugin:";

fn is_plugin_subject(s: &str) -> bool {
    s.starts_with(PLUGIN_PREFIX) && s.len() > PLUGIN_PREFIX.len()
}

/// Condition on the instance a rule was granted for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cond {
    Any,
    /// The instance is the caller (`User.id`, `FliksRequest.userId`).
    Own,
    /// Own and `status = 'pending'`.
    OwnPending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permissions {
    rules: Vec<(Action, Subject, Cond)>,
}

impl Permissions {
    /// `is_admin` wins over the role (`User.permissions` getter); a stored `manage:all` is the same grant.
    pub fn from(perms: &[String], is_admin: bool) -> Self {
        use Action::*;
        use Subject as S;
        let mut rules: Vec<(Action, Subject, Cond)> = Vec::new();
        if is_admin || perms.iter().any(|p| p == "manage:all") {
            rules.push((Manage, S::All, Cond::Any));
            return Self { rules };
        }
        let has = |p: &str| perms.iter().any(|x| x == p);
        let mut grant = |a: Action, s: Subject| rules.push((a, s, Cond::Any));
        for p in perms {
            if is_plugin_subject(p) {
                grant(Manage, S::Plugin(p.clone()));
            } else if let Some((action, subject)) = p.split_once(':')
                && is_plugin_subject(subject)
                && let Ok(a) = action.parse()
            {
                grant(a, S::Plugin(subject.to_owned()));
            }
        }
        for a in [Read, Create, Update, Delete] {
            grant(a, S::Playlist);
        }
        if has("media.read") {
            for s in [
                S::Media,
                S::QualityProfile,
                S::LanguageProfile,
                S::SubtitleFile,
                S::SubtitleProvider,
                S::Library,
            ] {
                grant(Read, s);
            }
        }
        if has("media.create") {
            grant(Create, S::Media);
        }
        if has("media.edit") {
            grant(Update, S::Media);
        }
        if has("media.delete") {
            grant(Delete, S::Media);
        }
        if has("media.grab") {
            grant(Grab, S::Media);
        }
        if has("livetv.read") {
            grant(Read, S::LiveTvChannel);
        }
        if has("media.create") || has("requests.create") {
            grant(Track, S::Media);
        }
        if has("requests.create") {
            grant(Create, S::FliksRequest);
        }
        if has("requests.manage") {
            grant(Manage, S::FliksRequest);
        }
        if has("subtitles.manage") {
            for a in [Create, Update, Delete] {
                grant(a, S::SubtitleFile);
            }
        }
        if has("settings.access") {
            grant(Read, S::Settings);
            for s in [
                S::Settings,
                S::QualityProfile,
                S::LanguageProfile,
                S::SubtitleProvider,
                S::TranslationProvider,
                S::Library,
            ] {
                grant(Manage, s);
            }
        }
        if has("users.manage") {
            grant(Manage, S::User);
            grant(Read, S::Role);
        }
        if has("roles.manage") {
            grant(Manage, S::Role);
        }
        rules.push((Read, S::User, Cond::Own));
        rules.push((Update, S::User, Cond::Own));
        if has("requests.create") {
            rules.push((Read, S::FliksRequest, Cond::Own));
            rules.push((Delete, S::FliksRequest, Cond::OwnPending));
            rules.push((Update, S::FliksRequest, Cond::OwnPending));
        }
        Self { rules }
    }

    /// Class level: any rule for the action and subject, conditions ignored (auth.md rule 26).
    pub fn can(&self, action: Action, subject: &Subject) -> bool {
        self.matching(action, subject).next().is_some()
    }

    /// Instance level for a `User`: `is_self` is whether it is the caller.
    pub fn can_user(&self, action: Action, is_self: bool) -> bool {
        self.can_instance(action, &Subject::User, is_self, false)
    }

    /// Instance level for a `FliksRequest`: `own` is `userId == caller`, `pending` is `status == 'pending'`.
    pub fn can_request(&self, action: Action, own: bool, pending: bool) -> bool {
        self.can_instance(action, &Subject::FliksRequest, own, pending)
    }

    fn can_instance(&self, action: Action, subject: &Subject, own: bool, pending: bool) -> bool {
        self.matching(action, subject).any(|c| match c {
            Cond::Any => true,
            Cond::Own => own,
            Cond::OwnPending => own && pending,
        })
    }

    /// Conditions of the rules that grant `action` on `subject`; `manage` matches any action, `all` any subject.
    fn matching(&self, action: Action, subject: &Subject) -> impl Iterator<Item = Cond> {
        self.rules
            .iter()
            .filter(move |(a, s, _)| {
                (*a == Action::Manage || *a == action) && (*s == Subject::All || s == subject)
            })
            .map(|(_, _, c)| *c)
    }
}

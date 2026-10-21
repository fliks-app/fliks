# Cleanup rules

Cleanup rules flag stale media in your libraries and remove it once a grace period ends. Rules live in Settings, Library cleanup. Everything below can be loaded with the Import button, which creates the rule disabled: check it with Preview, then switch it on.

A rule matches a media when every criterion it sets holds. When several rules match the same media, the rule created first owns it. A flagged title shows up in the "leaving soon" row, and Keep removes it from the list for good.

Library names in a rule file must match your libraries exactly. Replace `Movies` and `Series` with your own, or delete the `libraryIds` line to cover every library.

An exported rule file is `{fliksCleanupRule: 1, name, enabled, action, graceDays, criteria}`. Libraries are written by name, so a file moves between servers.

## Watched and untouched for 90 days

Movies the requester has watched, that nobody has played for three months.

```json
{
  "fliksCleanupRule": 1,
  "name": "Watched and untouched for 90 days",
  "enabled": false,
  "action": "delete",
  "graceDays": 14,
  "criteria": {
    "mediaType": "movie",
    "watchedByRequester": true,
    "lastPlayedOlderThanDays": 90
  }
}
```

## Never watched after a year

Anything added more than a year ago that nobody ever started. It only flags: nothing is removed.

```json
{
  "fliksCleanupRule": 1,
  "name": "Never watched after a year",
  "enabled": false,
  "action": "none",
  "graceDays": 30,
  "criteria": {
    "neverPlayed": true,
    "addedOlderThanDays": 365
  }
}
```

## Low-rated and big

Movies rated under 5 (with at least 100 votes) that take more than 20 GB.

```json
{
  "fliksCleanupRule": 1,
  "name": "Low-rated and big",
  "enabled": false,
  "action": "delete",
  "graceDays": 7,
  "criteria": {
    "mediaType": "movie",
    "ratingBelow": 5,
    "minVotes": 100,
    "sizeAboveGb": 20
  }
}
```

## Free space when the disk fills up

On the `Movies` library only, when its disk has less than 10% free, flag movies nobody played for 180 days and free their files while keeping the entry (it can be downloaded again).

```json
{
  "fliksCleanupRule": 1,
  "name": "Free space when the disk fills up",
  "enabled": false,
  "action": "delete_files_unmonitor",
  "graceDays": 7,
  "criteria": {
    "libraryIds": ["Movies"],
    "diskFreeBelowPercent": 10,
    "lastPlayedOlderThanDays": 180
  }
}
```

## Ended series, outside the kids library

Ended series nobody liked and nobody played for a year, in every library except `Kids`.

```json
{
  "fliksCleanupRule": 1,
  "name": "Ended series nobody liked",
  "enabled": false,
  "action": "delete",
  "graceDays": 30,
  "criteria": {
    "mediaType": "series",
    "seriesEnded": true,
    "notLiked": true,
    "lastPlayedOlderThanDays": 365,
    "excludeLibraryIds": ["Kids"]
  }
}
```

# Cleanup rules

Cleanup rules flag stale media in your libraries and remove it once a grace period ends. Rules live in Settings, Library cleanup. Everything below can be loaded with the Import button, which creates the rule disabled: check it with Preview, then switch it on.

A rule matches a media when every criterion it sets holds. When several rules match the same media, the rule created first owns it. A flagged title shows up in the "leaving soon" row, and Keep removes it from the list for good.

Library names in a rule file must match your libraries exactly. Replace `Movies` and `Series` with your own, or delete the `libraryIds` line to cover every library.

`levels` lists what the rule applies to: movies, plus at most one of series, seasons or episodes. Files from earlier versions (`fliksCleanupRule: 1`, with `level`) still import.

An exported rule file is `{fliksCleanupRule: 2, name, enabled, levels, action, graceDays, deleteSeriesWhenEmpty, reminderDays, criteria}`. Libraries are written by name, so a file moves between servers.

## Watched and untouched for 90 days

Movies the requester has watched, that nobody has played for three months.

```json
{
  "fliksCleanupRule": 2,
  "name": "Watched and untouched for 90 days",
  "enabled": false,
  "levels": ["movie"],
  "action": "delete",
  "graceDays": 14,
  "criteria": {
    "watchedByRequester": true,
    "lastPlayedOlderThanDays": 90
  }
}
```

## Never watched after a year

Movies added more than a year ago that nobody ever started. It only flags: nothing is removed.

```json
{
  "fliksCleanupRule": 2,
  "name": "Never watched after a year",
  "enabled": false,
  "levels": ["movie"],
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
  "fliksCleanupRule": 2,
  "name": "Low-rated and big",
  "enabled": false,
  "levels": ["movie"],
  "action": "delete",
  "graceDays": 7,
  "criteria": {
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
  "fliksCleanupRule": 2,
  "name": "Free space when the disk fills up",
  "enabled": false,
  "levels": ["movie"],
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
  "fliksCleanupRule": 2,
  "name": "Ended series nobody liked",
  "enabled": false,
  "levels": ["series"],
  "action": "delete",
  "graceDays": 30,
  "criteria": {
    "seriesEnded": true,
    "notLiked": true,
    "lastPlayedOlderThanDays": 365,
    "excludeLibraryIds": ["Kids"]
  }
}
```

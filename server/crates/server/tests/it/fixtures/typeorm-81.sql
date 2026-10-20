CREATE TYPE public.media_servers_type_enum AS ENUM (
    'local',
    'jellyfin',
    'emby',
    'plex'
);

CREATE TYPE public.media_status_enum AS ENUM (
    'tba',
    'announced',
    'released',
    'ended',
    'continuing',
    'deleted'
);

CREATE TYPE public.media_type_enum AS ENUM (
    'movie',
    'series'
);

CREATE TYPE public.playlist_shares_role_enum AS ENUM (
    'viewer',
    'editor',
    'administrator'
);

CREATE TYPE public.playlists_visibility_enum AS ENUM (
    'private',
    'followers',
    'public'
);

CREATE TYPE public.plugin_packages_origin_enum AS ENUM (
    'catalog',
    'manual'
);

CREATE TYPE public.plugin_packages_status_enum AS ENUM (
    'active',
    'failed'
);

CREATE TYPE public.requests_kind_enum AS ENUM (
    'add',
    'delete'
);

CREATE TYPE public.requests_mediatype_enum AS ENUM (
    'movie',
    'series'
);

CREATE TYPE public.requests_status_enum AS ENUM (
    'pending',
    'approved',
    'declined',
    'processing',
    'available',
    'failed'
);

CREATE TYPE public.subtitle_files_providertype_enum AS ENUM (
    'opensubtitles',
    'subscene',
    'sous_titres_eu',
    'subdl',
    'subsynchro',
    'supersubtitles',
    'whisper',
    'yify',
    'gestdown',
    'embedded',
    'radarr',
    'sonarr',
    'disk',
    'ocr',
    'translated'
);

CREATE TYPE public.subtitle_files_status_enum AS ENUM (
    'missing',
    'downloaded',
    'upgraded',
    'synced',
    'failed',
    'embedded',
    'processing'
);

CREATE TYPE public.subtitle_providers_type_enum AS ENUM (
    'opensubtitles',
    'subscene',
    'sous_titres_eu',
    'subdl',
    'subsynchro',
    'supersubtitles',
    'whisper',
    'yify',
    'gestdown',
    'embedded',
    'radarr',
    'sonarr',
    'disk',
    'ocr',
    'translated'
);

CREATE TYPE public.translation_providers_engine_enum AS ENUM (
    'gemini',
    'openai',
    'libretranslate'
);

CREATE TYPE public.user_follows_status_enum AS ENUM (
    'pending',
    'accepted'
);

CREATE TYPE public.users_mediaservertype_enum AS ENUM (
    'local',
    'jellyfin',
    'emby',
    'plex'
);

CREATE TYPE public.users_profilevisibility_enum AS ENUM (
    'public',
    'private'
);

CREATE TABLE public.app_settings (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    key character varying NOT NULL,
    value text
);

CREATE SEQUENCE public.app_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.app_settings_id_seq OWNED BY public.app_settings.id;

CREATE TABLE public.auto_approval_rules (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    criteria jsonb NOT NULL
);

CREATE SEQUENCE public.auto_approval_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.auto_approval_rules_id_seq OWNED BY public.auto_approval_rules.id;

CREATE TABLE public.commands (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    status character varying DEFAULT 'queued'::character varying NOT NULL,
    "startedOn" timestamp with time zone,
    "endedOn" timestamp with time zone,
    trigger character varying DEFAULT 'manual'::character varying NOT NULL,
    body jsonb
);

CREATE SEQUENCE public.commands_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.commands_id_seq OWNED BY public.commands.id;

CREATE TABLE public.content_recommendations (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "senderId" integer NOT NULL,
    "recipientId" integer NOT NULL,
    "mediaId" integer NOT NULL,
    "seasonId" integer,
    "episodeId" integer,
    message text,
    "dismissedAt" timestamp with time zone
);

CREATE SEQUENCE public.content_recommendations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.content_recommendations_id_seq OWNED BY public.content_recommendations.id;

CREATE TABLE public.custom_formats (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    specs jsonb DEFAULT '[]'::jsonb CONSTRAINT custom_formats_specifications_not_null NOT NULL
);

CREATE SEQUENCE public.custom_formats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_formats_id_seq OWNED BY public.custom_formats.id;

CREATE TABLE public.episode_markers (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    type character varying(16) NOT NULL,
    "startSeconds" double precision NOT NULL,
    "endSeconds" double precision NOT NULL,
    confidence double precision DEFAULT '1'::double precision NOT NULL,
    manual boolean DEFAULT false NOT NULL,
    "episodeId" integer
);

CREATE SEQUENCE public.episode_markers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.episode_markers_id_seq OWNED BY public.episode_markers.id;

CREATE TABLE public.episodes (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "episodeNumber" integer NOT NULL,
    "endEpisodeNumber" integer,
    title character varying,
    overview text,
    "airDate" date,
    runtime integer,
    monitored boolean DEFAULT true NOT NULL,
    "hasFile" boolean DEFAULT false NOT NULL,
    "stillUrl" text,
    "markersScannedAt" timestamp with time zone,
    "searchVector" tsvector,
    "seasonId" integer
);

CREATE SEQUENCE public.episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.episodes_id_seq OWNED BY public.episodes.id;

CREATE TABLE public.language_profiles (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    "audioLanguages" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "subtitleLanguages" jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE SEQUENCE public.language_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.language_profiles_id_seq OWNED BY public.language_profiles.id;

CREATE TABLE public.libraries (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    icon character varying(48),
    color character varying(32),
    "mediaTypes" jsonb DEFAULT '["movie", "series"]'::jsonb NOT NULL,
    "preferredProvider" character varying,
    "defaultQualityProfileId" integer,
    "defaultLanguageProfileId" integer,
    path character varying,
    label character varying,
    "metadataLanguage" character varying(8),
    "metadataRegion" character varying(8)
);

CREATE SEQUENCE public.libraries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.libraries_id_seq OWNED BY public.libraries.id;

CREATE TABLE public.library_user_access (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "libraryId" integer,
    "userId" integer
);

CREATE SEQUENCE public.library_user_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.library_user_access_id_seq OWNED BY public.library_user_access.id;

CREATE TABLE public.likes (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "mediaId" integer NOT NULL,
    "seasonId" integer,
    "episodeId" integer
);

CREATE SEQUENCE public.likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.likes_id_seq OWNED BY public.likes.id;

CREATE TABLE public.livetv_channel_streams (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "externalId" character varying NOT NULL,
    url text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    "qualityLabel" character varying,
    "providerName" character varying NOT NULL,
    "userAgent" character varying,
    referer character varying,
    "lastSeenAt" timestamp with time zone,
    "probedVideoCodec" character varying(32),
    "probedAudioCodec" character varying(32),
    "probedContainer" character varying(64),
    "lastOkAt" timestamp with time zone,
    "lastError" text,
    "channelId" integer,
    "sourceId" integer
);

CREATE SEQUENCE public.livetv_channel_streams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_channel_streams_id_seq OWNED BY public.livetv_channel_streams.id;

CREATE TABLE public.livetv_channels (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    number integer,
    "logoPath" text,
    "groupName" character varying,
    enabled boolean DEFAULT false NOT NULL,
    "sortIndex" integer DEFAULT 0 NOT NULL,
    "guideChannelId" character varying,
    "guideMatchKind" character varying(16),
    "guideShiftMinutes" integer DEFAULT 0 NOT NULL,
    "lastPlayedAt" timestamp with time zone,
    "lastErrorAt" timestamp with time zone,
    "consecutiveFailures" integer DEFAULT 0 NOT NULL,
    "groupNameSource" character varying(16) DEFAULT 'provider'::character varying NOT NULL
);

CREATE SEQUENCE public.livetv_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_channels_id_seq OWNED BY public.livetv_channels.id;

CREATE TABLE public.livetv_group_access (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "groupName" character varying NOT NULL,
    "userId" integer
);

CREATE SEQUENCE public.livetv_group_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_group_access_id_seq OWNED BY public.livetv_group_access.id;

CREATE TABLE public.livetv_guide_channels (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "channelId" character varying NOT NULL,
    "displayNames" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "iconUrl" text,
    "guideSourceId" integer
);

CREATE SEQUENCE public.livetv_guide_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_guide_channels_id_seq OWNED BY public.livetv_guide_channels.id;

CREATE TABLE public.livetv_guide_sources (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    kind character varying(16) DEFAULT 'xmltv'::character varying NOT NULL,
    url text,
    "refreshIntervalHours" integer DEFAULT 12 NOT NULL,
    "timezoneOffsetMinutes" integer DEFAULT 0 NOT NULL,
    language character varying(16),
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "lastSyncAt" timestamp with time zone,
    "lastSyncStatus" character varying(16) DEFAULT 'never'::character varying NOT NULL,
    "lastSyncError" text,
    "programCount" integer DEFAULT 0 NOT NULL,
    etag character varying,
    "lastModified" character varying,
    "sourceId" integer
);

CREATE SEQUENCE public.livetv_guide_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_guide_sources_id_seq OWNED BY public.livetv_guide_sources.id;

CREATE TABLE public.livetv_programs (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "guideChannelId" character varying NOT NULL,
    "startsAt" timestamp with time zone NOT NULL,
    "endsAt" timestamp with time zone NOT NULL,
    title character varying NOT NULL,
    subtitle character varying,
    description text,
    categories jsonb DEFAULT '[]'::jsonb NOT NULL,
    "iconUrl" text,
    "seasonNumber" integer,
    "episodeNumber" integer,
    "seriesId" character varying,
    "isNew" boolean DEFAULT false NOT NULL,
    "isLive" boolean DEFAULT false NOT NULL,
    rating character varying(32),
    year integer,
    "guideSourceId" integer
);

CREATE SEQUENCE public.livetv_programs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_programs_id_seq OWNED BY public.livetv_programs.id;

CREATE TABLE public.livetv_sources (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    kind character varying(16) DEFAULT 'm3u'::character varying NOT NULL,
    url text NOT NULL,
    username character varying,
    password character varying,
    "userAgent" character varying,
    referer character varying,
    "maxStreams" integer DEFAULT 0 NOT NULL,
    "maxStreamsIsManual" boolean DEFAULT false NOT NULL,
    "refreshIntervalHours" integer DEFAULT 12 NOT NULL,
    "includeGroupsPattern" text,
    "excludeGroupsPattern" text,
    "expiresAt" timestamp with time zone,
    "accountStatus" character varying,
    "guideUrls" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "playlistEtag" character varying,
    "playlistLastModified" character varying,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    "lastSyncAt" timestamp with time zone,
    "lastSyncStatus" character varying(16) DEFAULT 'never'::character varying NOT NULL,
    "lastSyncError" text,
    "channelCount" integer DEFAULT 0 NOT NULL,
    "lastAdultGuardError" text
);

CREATE SEQUENCE public.livetv_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_sources_id_seq OWNED BY public.livetv_sources.id;

CREATE TABLE public.livetv_user_channel_prefs (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    favorite boolean DEFAULT false NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    "lastPlayedAt" timestamp with time zone,
    "userId" integer,
    "channelId" integer
);

CREATE SEQUENCE public.livetv_user_channel_prefs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.livetv_user_channel_prefs_id_seq OWNED BY public.livetv_user_channel_prefs.id;

CREATE TABLE public.media (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    title character varying NOT NULL,
    "originalTitle" character varying,
    year integer,
    type public.media_type_enum NOT NULL,
    "tmdbId" integer,
    "imdbId" character varying,
    "tvdbId" integer,
    overview text,
    status public.media_status_enum DEFAULT 'tba'::public.media_status_enum NOT NULL,
    monitored boolean DEFAULT true NOT NULL,
    "preferredProvider" character varying(16),
    "folderName" character varying,
    "posterUrl" character varying,
    "metadataRefreshedAt" timestamp with time zone,
    "fanartUrl" character varying,
    rating double precision,
    genres jsonb,
    runtime integer,
    "releaseDate" date,
    "inCinemas" date,
    "digitalRelease" date,
    "physicalRelease" date,
    "minimumAvailability" character varying DEFAULT 'released'::character varying NOT NULL,
    "searchVector" tsvector,
    "libraryId" integer,
    "qualityProfileId" integer,
    "languageProfileId" integer,
    "addedById" integer,
    "alternativeTitles" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "tmdbCollectionId" integer,
    "tmdbCollectionName" character varying,
    "additionalFanartUrls" text[] DEFAULT '{}'::text[] NOT NULL,
    "logoUrl" character varying
);

CREATE TABLE public.media_cast (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "character" character varying NOT NULL,
    "order" integer NOT NULL,
    "mediaId" integer,
    "personId" integer
);

CREATE SEQUENCE public.media_cast_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_cast_id_seq OWNED BY public.media_cast.id;

CREATE TABLE public.media_crew (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    job character varying NOT NULL,
    department character varying NOT NULL,
    "mediaId" integer,
    "personId" integer
);

CREATE SEQUENCE public.media_crew_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_crew_id_seq OWNED BY public.media_crew.id;

CREATE TABLE public.media_file_scans (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "mediaFileId" integer NOT NULL,
    size bigint NOT NULL,
    "mtimeMs" double precision NOT NULL,
    scan jsonb NOT NULL
);

CREATE SEQUENCE public.media_file_scans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_file_scans_id_seq OWNED BY public.media_file_scans.id;

CREATE TABLE public.media_files (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "relativePath" character varying NOT NULL,
    size bigint NOT NULL,
    quality character varying NOT NULL,
    language character varying,
    "streamInfo" jsonb,
    "mediaId" integer,
    "episodeId" integer,
    "osdbHash" character varying(16),
    "osdbBytesize" bigint
);

CREATE SEQUENCE public.media_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_files_id_seq OWNED BY public.media_files.id;

CREATE SEQUENCE public.media_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_id_seq OWNED BY public.media.id;

CREATE TABLE public.media_metadata (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    budget bigint,
    revenue bigint,
    tagline character varying,
    popularity double precision,
    "voteCount" integer,
    "originalLanguage" character varying,
    "productionCountries" jsonb,
    "productionCompanies" jsonb,
    videos jsonb,
    keywords jsonb,
    "mediaId" integer
);

CREATE SEQUENCE public.media_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_metadata_id_seq OWNED BY public.media_metadata.id;

CREATE TABLE public.media_servers (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    type public.media_servers_type_enum NOT NULL,
    url character varying NOT NULL,
    "apiKey" character varying,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.media_servers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.media_servers_id_seq OWNED BY public.media_servers.id;

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;

CREATE TABLE public.notification_connections (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    type character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.notification_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_connections_id_seq OWNED BY public.notification_connections.id;

CREATE TABLE public.pairing_requests (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "publicId" character varying NOT NULL,
    "userId" integer NOT NULL,
    "deviceId" character varying NOT NULL,
    "deviceName" character varying NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    "approvedByUserId" integer,
    "accessToken" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "systemName" character varying(60)
);

CREATE SEQUENCE public.pairing_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pairing_requests_id_seq OWNED BY public.pairing_requests.id;

CREATE TABLE public.persons (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "tmdbId" integer NOT NULL,
    name character varying NOT NULL,
    "avatarUrl" character varying,
    biography text,
    birthday date,
    deathday date,
    "placeOfBirth" character varying,
    "knownForDepartment" character varying,
    departments jsonb DEFAULT '[]'::jsonb NOT NULL,
    "metadataRefreshedAt" timestamp with time zone,
    "searchVector" tsvector,
    provider character varying(16) DEFAULT 'tmdb'::character varying NOT NULL
);

CREATE SEQUENCE public.persons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.persons_id_seq OWNED BY public.persons.id;

CREATE TABLE public.playback_qoe_events (
    id integer NOT NULL,
    "sessionId" character varying(64) NOT NULL,
    at timestamp with time zone NOT NULL,
    type character varying NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE SEQUENCE public.playback_qoe_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playback_qoe_events_id_seq OWNED BY public.playback_qoe_events.id;

CREATE TABLE public.playback_qoe_sessions (
    "sessionId" character varying(64) NOT NULL,
    "playbackId" character varying(64),
    "userId" integer,
    "mediaFileId" integer,
    "mediaTitle" character varying,
    "startedAt" timestamp with time zone NOT NULL,
    "lastSeenAt" timestamp with time zone NOT NULL,
    "endedAt" timestamp with time zone,
    "deviceLabel" character varying,
    "systemName" character varying,
    "appVersion" character varying,
    engine character varying,
    cmcd boolean DEFAULT false NOT NULL,
    "cmcdClaimed" boolean DEFAULT false NOT NULL,
    "playMethod" character varying,
    quality character varying,
    "transcodeReasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "videoCodec" character varying,
    width integer,
    height integer,
    "decoderName" character varying,
    "hwDecoder" boolean,
    "watchedMs" integer DEFAULT 0 NOT NULL,
    "stallCount" integer DEFAULT 0 NOT NULL,
    "stallMs" integer DEFAULT 0 NOT NULL,
    "droppedFrames" integer,
    "decodedFrames" integer,
    "avgBandwidthBps" double precision,
    "minBandwidthBps" double precision,
    "avgVariantBitrate" double precision,
    "recoveryReloads" integer DEFAULT 0 NOT NULL,
    "errorCount" integer DEFAULT 0 NOT NULL,
    "medianTranscodeSpeed" double precision,
    "stallBufferAheadS" double precision,
    "stallBandwidthBps" double precision,
    "cmcdThroughputBps" double precision,
    "unrecoveredError" boolean DEFAULT false NOT NULL,
    "sampleCount" integer DEFAULT 0 NOT NULL,
    "stallCauseMs" jsonb,
    "stallReasonMs" jsonb,
    pipeline jsonb,
    verdict character varying DEFAULT 'unknown'::character varying NOT NULL,
    confidence character varying DEFAULT 'low'::character varying NOT NULL,
    reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    "playbackVerdict" character varying DEFAULT 'unknown'::character varying NOT NULL,
    "playbackConfidence" character varying DEFAULT 'low'::character varying NOT NULL
);

CREATE TABLE public.playback_states (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "positionSeconds" double precision DEFAULT '0'::double precision NOT NULL,
    "durationSeconds" double precision DEFAULT '0'::double precision,
    completed boolean DEFAULT false NOT NULL,
    "hiddenFromContinueWatching" boolean DEFAULT false NOT NULL,
    "lastPlayedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "playedAt" timestamp with time zone,
    "userId" integer,
    "mediaId" integer,
    "mediaFileId" integer,
    "episodeId" integer
);

CREATE SEQUENCE public.playback_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playback_states_id_seq OWNED BY public.playback_states.id;

CREATE TABLE public.playlist_items (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "playlistId" integer NOT NULL,
    "mediaId" integer NOT NULL,
    "episodeId" integer,
    "position" integer NOT NULL,
    "addedById" integer
);

CREATE SEQUENCE public.playlist_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playlist_items_id_seq OWNED BY public.playlist_items.id;

CREATE TABLE public.playlist_saves (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "playlistId" integer NOT NULL
);

CREATE SEQUENCE public.playlist_saves_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playlist_saves_id_seq OWNED BY public.playlist_saves.id;

CREATE TABLE public.playlist_shares (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "playlistId" integer NOT NULL,
    "userId" integer NOT NULL,
    role public.playlist_shares_role_enum DEFAULT 'viewer'::public.playlist_shares_role_enum NOT NULL
);

CREATE SEQUENCE public.playlist_shares_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playlist_shares_id_seq OWNED BY public.playlist_shares.id;

CREATE TABLE public.playlists (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(255) NOT NULL,
    "ownerId" integer NOT NULL,
    "autoRemoveWatched" boolean DEFAULT false NOT NULL,
    "autoDownload" boolean DEFAULT false NOT NULL,
    "coverImageUrl" character varying(512),
    "autoPlay" boolean DEFAULT false NOT NULL,
    visibility public.playlists_visibility_enum DEFAULT 'private'::public.playlists_visibility_enum NOT NULL
);

CREATE SEQUENCE public.playlists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.playlists_id_seq OWNED BY public.playlists.id;

CREATE TABLE public.plugin_packages (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "pluginId" character varying NOT NULL,
    version character varying NOT NULL,
    archive bytea NOT NULL,
    origin public.plugin_packages_origin_enum NOT NULL,
    signature character varying NOT NULL,
    "verifiedByKeyId" character varying,
    manifest jsonb NOT NULL,
    status public.plugin_packages_status_enum DEFAULT 'active'::public.plugin_packages_status_enum NOT NULL,
    "statusReason" text,
    enabled boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.plugin_packages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.plugin_packages_id_seq OWNED BY public.plugin_packages.id;

CREATE TABLE public.plugin_registrations (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "pluginId" character varying NOT NULL,
    "ingestRoots" text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    manifest jsonb NOT NULL,
    "childUid" integer
);

CREATE SEQUENCE public.plugin_registrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.plugin_registrations_id_seq OWNED BY public.plugin_registrations.id;

CREATE TABLE public.plugin_sources (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    url character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "publicKey" bytea,
    "lastRefreshedAt" timestamp with time zone,
    "lastRefreshError" text,
    "cachedCatalog" jsonb
);

CREATE SEQUENCE public.plugin_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.plugin_sources_id_seq OWNED BY public.plugin_sources.id;

CREATE TABLE public.quality_definitions (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "qualityId" integer NOT NULL,
    title character varying NOT NULL,
    "minSize" double precision DEFAULT '0'::double precision NOT NULL,
    "preferredSize" double precision DEFAULT '0'::double precision NOT NULL,
    "maxSize" double precision DEFAULT '0'::double precision NOT NULL
);

CREATE SEQUENCE public.quality_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.quality_definitions_id_seq OWNED BY public.quality_definitions.id;

CREATE TABLE public.quality_profiles (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    cutoff integer NOT NULL,
    items jsonb NOT NULL,
    "upgradeAllowed" boolean DEFAULT false NOT NULL,
    "resolutionUpgradeOnly" boolean DEFAULT false NOT NULL,
    "minCustomFormatScore" integer DEFAULT 0 NOT NULL
);

CREATE SEQUENCE public.quality_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.quality_profiles_id_seq OWNED BY public.quality_profiles.id;

CREATE TABLE public.recommendation_dismissals (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "mediaId" integer NOT NULL
);

CREATE SEQUENCE public.recommendation_dismissals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.recommendation_dismissals_id_seq OWNED BY public.recommendation_dismissals.id;

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "tokenHash" character varying(64) NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "revokedAt" timestamp with time zone,
    "userAgent" character varying(255),
    "lastUsedAt" timestamp with time zone
);

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;

CREATE TABLE public.remote_control_grants (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    code character varying(12),
    "deviceId" character varying NOT NULL,
    "ownerUserId" integer NOT NULL,
    "granteeUserId" integer,
    "deviceName" character varying NOT NULL,
    "codeExpiresAt" timestamp with time zone NOT NULL
);

CREATE SEQUENCE public.remote_control_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.remote_control_grants_id_seq OWNED BY public.remote_control_grants.id;

CREATE TABLE public.request_comments (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    message text NOT NULL,
    "requestId" integer,
    "userId" integer
);

CREATE SEQUENCE public.request_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.request_comments_id_seq OWNED BY public.request_comments.id;

CREATE TABLE public.requests (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "mediaType" public.requests_mediatype_enum NOT NULL,
    "tmdbId" integer NOT NULL,
    title character varying NOT NULL,
    status public.requests_status_enum DEFAULT 'pending'::public.requests_status_enum NOT NULL,
    "declinedReason" text,
    seasons jsonb,
    "userId" integer,
    "approvedById" integer,
    "qualityProfileId" integer,
    "languageProfileId" integer,
    "libraryId" integer,
    "mediaId" integer,
    "posterUrl" text,
    "fanartUrl" text,
    kind public.requests_kind_enum DEFAULT 'add'::public.requests_kind_enum NOT NULL
);

CREATE SEQUENCE public.requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.requests_id_seq OWNED BY public.requests.id;

CREATE TABLE public.role_default_libraries (
    "roleId" integer NOT NULL,
    "libraryId" integer NOT NULL
);

CREATE TABLE public.roles (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    permissions text DEFAULT '[]'::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

CREATE TABLE public.seasons (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "seasonNumber" integer NOT NULL,
    monitored boolean DEFAULT true NOT NULL,
    "preferredProvider" character varying(16),
    "mediaId" integer,
    "posterUrl" text,
    overview text,
    "airDate" character varying(10)
);

CREATE SEQUENCE public.seasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.seasons_id_seq OWNED BY public.seasons.id;

CREATE TABLE public.subtitle_blacklist (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "providerType" character varying NOT NULL,
    "providerFileId" character varying NOT NULL,
    language character varying,
    "sourceTitle" character varying,
    reason character varying,
    "mediaId" integer
);

CREATE SEQUENCE public.subtitle_blacklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subtitle_blacklist_id_seq OWNED BY public.subtitle_blacklist.id;

CREATE TABLE public.subtitle_files (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    language character varying NOT NULL,
    forced boolean DEFAULT false NOT NULL,
    "hearingImpaired" boolean DEFAULT false NOT NULL,
    "providerType" public.subtitle_files_providertype_enum NOT NULL,
    "providerFileId" character varying,
    "filePath" character varying,
    status public.subtitle_files_status_enum DEFAULT 'downloaded'::public.subtitle_files_status_enum NOT NULL,
    "streamIndex" integer,
    codec character varying,
    score integer DEFAULT 0 NOT NULL,
    synced boolean DEFAULT false NOT NULL,
    "syncOffset" integer,
    locked boolean DEFAULT false NOT NULL,
    tags text DEFAULT '[]'::text NOT NULL,
    "mediaId" integer,
    "episodeId" integer,
    "mediaFileId" integer,
    "hashMatched" boolean DEFAULT false NOT NULL,
    "sourceStreamIndex" integer,
    "translationProviderId" integer,
    "translationEngine" character varying,
    "translationModel" character varying,
    "translationProviderName" character varying,
    "errorMessage" text,
    "syncFailed" boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE public.subtitle_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subtitle_files_id_seq OWNED BY public.subtitle_files.id;

CREATE TABLE public.subtitle_provider_stats (
    id integer NOT NULL,
    "queryDate" timestamp without time zone DEFAULT now() NOT NULL,
    "queryType" character varying DEFAULT 'search'::character varying NOT NULL,
    "responseTimeMs" integer DEFAULT 0 NOT NULL,
    "resultCount" integer DEFAULT 0 NOT NULL,
    "errorMessage" text,
    "providerId" integer
);

CREATE SEQUENCE public.subtitle_provider_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subtitle_provider_stats_id_seq OWNED BY public.subtitle_provider_stats.id;

CREATE TABLE public.subtitle_providers (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    type public.subtitle_providers_type_enum NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 25 NOT NULL
);

CREATE SEQUENCE public.subtitle_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.subtitle_providers_id_seq OWNED BY public.subtitle_providers.id;

CREATE TABLE public.translation_providers (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    engine public.translation_providers_engine_enum NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE SEQUENCE public.translation_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.translation_providers_id_seq OWNED BY public.translation_providers.id;

CREATE TABLE public.user_follows (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "followerId" integer NOT NULL,
    "followingId" integer NOT NULL,
    status public.user_follows_status_enum DEFAULT 'accepted'::public.user_follows_status_enum NOT NULL
);

CREATE SEQUENCE public.user_follows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_follows_id_seq OWNED BY public.user_follows.id;

CREATE TABLE public.users (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    username character varying NOT NULL,
    email character varying,
    "passwordHash" character varying,
    "roleId" integer,
    "mediaServerType" public.users_mediaservertype_enum DEFAULT 'local'::public.users_mediaservertype_enum NOT NULL,
    "mediaServerId" character varying,
    avatar character varying,
    "lastLogin" timestamp with time zone,
    "isAdmin" boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "requirePasswordChange" boolean DEFAULT false NOT NULL,
    "movieQuotaLimit" integer DEFAULT 0 NOT NULL,
    "seriesQuotaLimit" integer DEFAULT 0 NOT NULL,
    "quotaPeriodDays" integer DEFAULT 7 NOT NULL,
    "libraryOrder" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "hiddenLibraryIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "profileVisibility" public.users_profilevisibility_enum DEFAULT 'private'::public.users_profilevisibility_enum NOT NULL,
    "shareTastes" boolean DEFAULT false NOT NULL,
    "shareRecommendations" boolean DEFAULT false NOT NULL,
    "shareWatchHistory" boolean DEFAULT false NOT NULL,
    "shareLikes" boolean DEFAULT false NOT NULL,
    "shareDisabled" boolean DEFAULT false NOT NULL,
    "shareStats" boolean DEFAULT false NOT NULL,
    "hideSpoilers" boolean DEFAULT false NOT NULL,
    "spoilerHideStills" boolean DEFAULT true NOT NULL,
    "spoilerHideOverviews" boolean DEFAULT true NOT NULL,
    "spoilerHideTitles" boolean DEFAULT true NOT NULL,
    "edlEnabled" boolean DEFAULT true NOT NULL,
    "edlAutoSkipCommercials" boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

ALTER TABLE ONLY public.app_settings ALTER COLUMN id SET DEFAULT nextval('public.app_settings_id_seq'::regclass);

ALTER TABLE ONLY public.auto_approval_rules ALTER COLUMN id SET DEFAULT nextval('public.auto_approval_rules_id_seq'::regclass);

ALTER TABLE ONLY public.commands ALTER COLUMN id SET DEFAULT nextval('public.commands_id_seq'::regclass);

ALTER TABLE ONLY public.content_recommendations ALTER COLUMN id SET DEFAULT nextval('public.content_recommendations_id_seq'::regclass);

ALTER TABLE ONLY public.custom_formats ALTER COLUMN id SET DEFAULT nextval('public.custom_formats_id_seq'::regclass);

ALTER TABLE ONLY public.episode_markers ALTER COLUMN id SET DEFAULT nextval('public.episode_markers_id_seq'::regclass);

ALTER TABLE ONLY public.episodes ALTER COLUMN id SET DEFAULT nextval('public.episodes_id_seq'::regclass);

ALTER TABLE ONLY public.language_profiles ALTER COLUMN id SET DEFAULT nextval('public.language_profiles_id_seq'::regclass);

ALTER TABLE ONLY public.libraries ALTER COLUMN id SET DEFAULT nextval('public.libraries_id_seq'::regclass);

ALTER TABLE ONLY public.library_user_access ALTER COLUMN id SET DEFAULT nextval('public.library_user_access_id_seq'::regclass);

ALTER TABLE ONLY public.likes ALTER COLUMN id SET DEFAULT nextval('public.likes_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_channel_streams ALTER COLUMN id SET DEFAULT nextval('public.livetv_channel_streams_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_channels ALTER COLUMN id SET DEFAULT nextval('public.livetv_channels_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_group_access ALTER COLUMN id SET DEFAULT nextval('public.livetv_group_access_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_guide_channels ALTER COLUMN id SET DEFAULT nextval('public.livetv_guide_channels_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_guide_sources ALTER COLUMN id SET DEFAULT nextval('public.livetv_guide_sources_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_programs ALTER COLUMN id SET DEFAULT nextval('public.livetv_programs_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_sources ALTER COLUMN id SET DEFAULT nextval('public.livetv_sources_id_seq'::regclass);

ALTER TABLE ONLY public.livetv_user_channel_prefs ALTER COLUMN id SET DEFAULT nextval('public.livetv_user_channel_prefs_id_seq'::regclass);

ALTER TABLE ONLY public.media ALTER COLUMN id SET DEFAULT nextval('public.media_id_seq'::regclass);

ALTER TABLE ONLY public.media_cast ALTER COLUMN id SET DEFAULT nextval('public.media_cast_id_seq'::regclass);

ALTER TABLE ONLY public.media_crew ALTER COLUMN id SET DEFAULT nextval('public.media_crew_id_seq'::regclass);

ALTER TABLE ONLY public.media_file_scans ALTER COLUMN id SET DEFAULT nextval('public.media_file_scans_id_seq'::regclass);

ALTER TABLE ONLY public.media_files ALTER COLUMN id SET DEFAULT nextval('public.media_files_id_seq'::regclass);

ALTER TABLE ONLY public.media_metadata ALTER COLUMN id SET DEFAULT nextval('public.media_metadata_id_seq'::regclass);

ALTER TABLE ONLY public.media_servers ALTER COLUMN id SET DEFAULT nextval('public.media_servers_id_seq'::regclass);

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);

ALTER TABLE ONLY public.notification_connections ALTER COLUMN id SET DEFAULT nextval('public.notification_connections_id_seq'::regclass);

ALTER TABLE ONLY public.pairing_requests ALTER COLUMN id SET DEFAULT nextval('public.pairing_requests_id_seq'::regclass);

ALTER TABLE ONLY public.persons ALTER COLUMN id SET DEFAULT nextval('public.persons_id_seq'::regclass);

ALTER TABLE ONLY public.playback_qoe_events ALTER COLUMN id SET DEFAULT nextval('public.playback_qoe_events_id_seq'::regclass);

ALTER TABLE ONLY public.playback_states ALTER COLUMN id SET DEFAULT nextval('public.playback_states_id_seq'::regclass);

ALTER TABLE ONLY public.playlist_items ALTER COLUMN id SET DEFAULT nextval('public.playlist_items_id_seq'::regclass);

ALTER TABLE ONLY public.playlist_saves ALTER COLUMN id SET DEFAULT nextval('public.playlist_saves_id_seq'::regclass);

ALTER TABLE ONLY public.playlist_shares ALTER COLUMN id SET DEFAULT nextval('public.playlist_shares_id_seq'::regclass);

ALTER TABLE ONLY public.playlists ALTER COLUMN id SET DEFAULT nextval('public.playlists_id_seq'::regclass);

ALTER TABLE ONLY public.plugin_packages ALTER COLUMN id SET DEFAULT nextval('public.plugin_packages_id_seq'::regclass);

ALTER TABLE ONLY public.plugin_registrations ALTER COLUMN id SET DEFAULT nextval('public.plugin_registrations_id_seq'::regclass);

ALTER TABLE ONLY public.plugin_sources ALTER COLUMN id SET DEFAULT nextval('public.plugin_sources_id_seq'::regclass);

ALTER TABLE ONLY public.quality_definitions ALTER COLUMN id SET DEFAULT nextval('public.quality_definitions_id_seq'::regclass);

ALTER TABLE ONLY public.quality_profiles ALTER COLUMN id SET DEFAULT nextval('public.quality_profiles_id_seq'::regclass);

ALTER TABLE ONLY public.recommendation_dismissals ALTER COLUMN id SET DEFAULT nextval('public.recommendation_dismissals_id_seq'::regclass);

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.remote_control_grants ALTER COLUMN id SET DEFAULT nextval('public.remote_control_grants_id_seq'::regclass);

ALTER TABLE ONLY public.request_comments ALTER COLUMN id SET DEFAULT nextval('public.request_comments_id_seq'::regclass);

ALTER TABLE ONLY public.requests ALTER COLUMN id SET DEFAULT nextval('public.requests_id_seq'::regclass);

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

ALTER TABLE ONLY public.seasons ALTER COLUMN id SET DEFAULT nextval('public.seasons_id_seq'::regclass);

ALTER TABLE ONLY public.subtitle_blacklist ALTER COLUMN id SET DEFAULT nextval('public.subtitle_blacklist_id_seq'::regclass);

ALTER TABLE ONLY public.subtitle_files ALTER COLUMN id SET DEFAULT nextval('public.subtitle_files_id_seq'::regclass);

ALTER TABLE ONLY public.subtitle_provider_stats ALTER COLUMN id SET DEFAULT nextval('public.subtitle_provider_stats_id_seq'::regclass);

ALTER TABLE ONLY public.subtitle_providers ALTER COLUMN id SET DEFAULT nextval('public.subtitle_providers_id_seq'::regclass);

ALTER TABLE ONLY public.translation_providers ALTER COLUMN id SET DEFAULT nextval('public.translation_providers_id_seq'::regclass);

ALTER TABLE ONLY public.user_follows ALTER COLUMN id SET DEFAULT nextval('public.user_follows_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "PK_0428f484e96f9e6a55955f29b5f" PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_formats
    ADD CONSTRAINT "PK_076675654bab65414d7c59160eb" PRIMARY KEY (id);

ALTER TABLE ONLY public.subtitle_provider_stats
    ADD CONSTRAINT "PK_07ed845bbe29f017fbadb2e1e06" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_group_access
    ADD CONSTRAINT "PK_15800fff943da31cff821faabe6" PRIMARY KEY (id);

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "PK_1d4ab28141e13ad42262cab12b3" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "PK_23d8433c02f6064c9c196423089" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_programs
    ADD CONSTRAINT "PK_270df4c18a60727a2340fbd97a2" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_channels
    ADD CONSTRAINT "PK_2e6f017729660b63bbc0de27db7" PRIMARY KEY (id);

ALTER TABLE ONLY public.subtitle_blacklist
    ADD CONSTRAINT "PK_3f978f16e490f314ac14a3b4a6a" PRIMARY KEY (id);

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "PK_40ce4d415c9dcfaf467b7473614" PRIMARY KEY (id);

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "PK_444fff397439c1f5b7918ebc5ec" PRIMARY KEY (id);

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT "PK_47780a1be9b93671c0286aedc06" PRIMARY KEY (id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT "PK_4800b266ba790931744b3e53a74" PRIMARY KEY (id);

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "PK_505fedfcad00a09b3734b4223de" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "PK_5e7987b481758c46a49f0301a8d" PRIMARY KEY (id);

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "PK_5eac3317df46210d0bd248d432d" PRIMARY KEY (id);

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT "PK_6a003fda8b0473fffc39cb831c7" PRIMARY KEY (id);

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "PK_6c52273ad7331542bbce7ae4da1" PRIMARY KEY (id);

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT "PK_74278d8812a049233ce41440ac7" PRIMARY KEY (id);

ALTER TABLE ONLY public.quality_profiles
    ADD CONSTRAINT "PK_77c6c3df9cc1a3f59166dc60764" PRIMARY KEY (id);

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT "PK_7ac292c3aa19300482b2b190d1e" PRIMARY KEY (id);

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_guide_channels
    ADD CONSTRAINT "PK_91d0f326b295847759cd57ae98c" PRIMARY KEY (id);

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "PK_93b4da6741cd150e76f9ac035d8" PRIMARY KEY (id);

ALTER TABLE ONLY public.pairing_requests
    ADD CONSTRAINT "PK_a088c08f7ba12dc7c2fa652cdb9" PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);

ALTER TABLE ONLY public.subtitle_providers
    ADD CONSTRAINT "PK_a9b2861711c6befdee0953d3994" PRIMARY KEY (id);

ALTER TABLE ONLY public.quality_definitions
    ADD CONSTRAINT "PK_ac863a00261a01b83b7677c2039" PRIMARY KEY (id);

ALTER TABLE ONLY public.media_file_scans
    ADD CONSTRAINT "PK_b43c049e9581265f39b2eabc472" PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_connections
    ADD CONSTRAINT "PK_b77540d9ad6ca4ac46e5db9f26d" PRIMARY KEY (id);

ALTER TABLE ONLY public.language_profiles
    ADD CONSTRAINT "PK_bf8bfa8caf3eece3d5224afe2be" PRIMARY KEY (id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY (id);

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "PK_c2828c911aaf4d21408bc1e03e8" PRIMARY KEY (id);

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "PK_c7acdb10cc62d7d2a1b57443de3" PRIMARY KEY ("roleId", "libraryId");

ALTER TABLE ONLY public.media_servers
    ADD CONSTRAINT "PK_c7f56b22b880f2d948ffe50b83e" PRIMARY KEY (id);

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT "PK_cb8ed53b5fe109dcd4a4449ec9d" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_sources
    ADD CONSTRAINT "PK_d63908dc94a2a3e9c02f8307d8e" PRIMARY KEY (id);

ALTER TABLE ONLY public.recommendation_dismissals
    ADD CONSTRAINT "PK_d64fd0160e105d4bcbaa1829711" PRIMARY KEY (id);

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "PK_dbd08312a26a16b56702859aa31" PRIMARY KEY (id);

ALTER TABLE ONLY public.auto_approval_rules
    ADD CONSTRAINT "PK_e15edc2d64990ed78a3a34b12b8" PRIMARY KEY (id);

ALTER TABLE ONLY public.livetv_guide_sources
    ADD CONSTRAINT "PK_ef3aedcfce4e1a3e5c0f53f4aa6" PRIMARY KEY (id);

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "PK_f4e0fcac36e050de337b670d8bd" PRIMARY KEY (id);

ALTER TABLE ONLY public.playback_qoe_events
    ADD CONSTRAINT "PK_playback_qoe_events" PRIMARY KEY (id);

ALTER TABLE ONLY public.playback_qoe_sessions
    ADD CONSTRAINT "PK_playback_qoe_sessions" PRIMARY KEY ("sessionId");

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "REL_62d457c000de0f01b2821a06ae" UNIQUE ("mediaId");

ALTER TABLE ONLY public.quality_definitions
    ADD CONSTRAINT "UQ_5f4831d8cb9a9bc845a98006aeb" UNIQUE ("qualityId");

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE (name);

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT "UQ_677a19ecc46b5da7b1a4314c82b" UNIQUE (provider, "tmdbId");

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "UQ_89a6bf94332e9f2715c4d06b36c" UNIQUE ("mediaId", "relativePath");

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT "UQ_975c2db59c65c05fd9c6b63a2ab" UNIQUE (key);

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "UQ_9fb3b11b4181af695b7cbf06d49" UNIQUE (name);

ALTER TABLE ONLY public.pairing_requests
    ADD CONSTRAINT "UQ_afa67f327d1abc474061454d0e8" UNIQUE ("publicId");

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "UQ_b5a9b3a47bd7b60b3cd2a778b18" UNIQUE ("libraryId", "userId");

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE (username);

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "UQ_playlist_saves_pair" UNIQUE ("userId", "playlistId");

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "UQ_playlist_shares_playlist_user" UNIQUE ("playlistId", "userId");

ALTER TABLE ONLY public.plugin_packages
    ADD CONSTRAINT "UQ_plugin_packages_pluginId" UNIQUE ("pluginId");

ALTER TABLE ONLY public.plugin_registrations
    ADD CONSTRAINT "UQ_plugin_registrations_child_uid" UNIQUE ("childUid");

ALTER TABLE ONLY public.plugin_registrations
    ADD CONSTRAINT "UQ_plugin_registrations_pluginId" UNIQUE ("pluginId");

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerId", "followingId");

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT content_recommendations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT playlist_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT playlist_saves_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT playlist_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.playlists
    ADD CONSTRAINT playlists_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plugin_packages
    ADD CONSTRAINT plugin_packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plugin_registrations
    ADD CONSTRAINT plugin_registrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plugin_sources
    ADD CONSTRAINT plugin_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.remote_control_grants
    ADD CONSTRAINT remote_control_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.translation_providers
    ADD CONSTRAINT translation_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT uq_episode_marker_type UNIQUE ("episodeId", type);

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT user_follows_pkey PRIMARY KEY (id);

CREATE INDEX "IDX_227d23190a49e5c40c6a4ccedd" ON public.playback_states USING btree ("userId", "episodeId", completed);

CREATE INDEX "IDX_2675281c4a4e36f69c7a07bff7" ON public.recommendation_dismissals USING btree ("userId");

CREATE INDEX "IDX_28efb3a0402a49dca862fb62e6" ON public.remote_control_grants USING btree ("granteeUserId");

CREATE INDEX "IDX_34d4b3c63c41ebc088ba3cfcdb" ON public.remote_control_grants USING btree ("deviceId");

CREATE INDEX "IDX_35326c2d082f6619e340bc365f" ON public.pairing_requests USING btree ("userId");

CREATE INDEX "IDX_590ddc457345bff7d6a9c70416" ON public.pairing_requests USING btree ("deviceId");

CREATE INDEX "IDX_642c4b48b2c022d0baae6cc122" ON public.role_default_libraries USING btree ("roleId");

CREATE INDEX "IDX_6cc8df2e63ef1cd8cf28bfc854" ON public.media_cast USING btree ("mediaId");

CREATE INDEX "IDX_735e31a7f8cf53db91cc04339d" ON public.remote_control_grants USING btree (code);

CREATE INDEX "IDX_7f3a35a769725163823e1162a9" ON public.role_default_libraries USING btree ("libraryId");

CREATE INDEX "IDX_8226529bf8b570cefa0bad2f96" ON public.media_crew USING btree ("personId");

CREATE INDEX "IDX_95c3254f4a9023b7f30c81c25f" ON public.media_crew USING btree ("mediaId");

CREATE INDEX "IDX_a5a52f3d116c44c2944f0b1088" ON public.remote_control_grants USING btree ("ownerUserId");

CREATE INDEX "IDX_a650813641a2f4136cfd6ae5a8" ON public.playback_states USING btree ("userId", "mediaId", completed);

CREATE INDEX "IDX_afa67f327d1abc474061454d0e" ON public.pairing_requests USING btree ("publicId");

CREATE INDEX "IDX_content_recommendations_recipient" ON public.content_recommendations USING btree ("recipientId");

CREATE INDEX "IDX_eb83c621e1daf59140e1e1be0a" ON public.playback_states USING btree ("userId", completed, "lastPlayedAt");

CREATE INDEX "IDX_f702d61f4cd1578c889ab3cadc" ON public.media_cast USING btree ("personId");

CREATE INDEX "IDX_likes_user" ON public.likes USING btree ("userId");

CREATE INDEX "IDX_livetv_channel_streams_channelId" ON public.livetv_channel_streams USING btree ("channelId");

CREATE INDEX "IDX_livetv_channels_group" ON public.livetv_channels USING btree ("groupName");

CREATE INDEX "IDX_livetv_channels_group_norm" ON public.livetv_channels USING btree (lower(btrim(("groupName")::text)));

CREATE INDEX "IDX_livetv_channels_guide" ON public.livetv_channels USING btree ("guideChannelId");

CREATE INDEX "IDX_livetv_programs_channel_start" ON public.livetv_programs USING btree ("guideChannelId", "startsAt");

CREATE INDEX "IDX_livetv_programs_source_channel_start" ON public.livetv_programs USING btree ("guideSourceId", "guideChannelId", "startsAt");

CREATE INDEX "IDX_livetv_programs_window" ON public.livetv_programs USING btree ("startsAt", "endsAt");

CREATE INDEX "IDX_media_addedById" ON public.media USING btree ("addedById");

CREATE INDEX "IDX_playback_qoe_events_session" ON public.playback_qoe_events USING btree ("sessionId");

CREATE INDEX "IDX_playback_qoe_sessions_device" ON public.playback_qoe_sessions USING btree ("deviceLabel");

CREATE INDEX "IDX_playback_qoe_sessions_last_seen" ON public.playback_qoe_sessions USING btree ("lastSeenAt");

CREATE INDEX "IDX_playback_qoe_sessions_playback" ON public.playback_qoe_sessions USING btree ("userId", "playbackId");

CREATE INDEX "IDX_playback_qoe_sessions_playback_verdict" ON public.playback_qoe_sessions USING btree ("playbackVerdict");

CREATE INDEX "IDX_playlist_items_addedById" ON public.playlist_items USING btree ("addedById");

CREATE INDEX "IDX_playlist_items_episodeId" ON public.playlist_items USING btree ("episodeId");

CREATE INDEX "IDX_playlist_items_mediaId" ON public.playlist_items USING btree ("mediaId");

CREATE INDEX "IDX_playlist_items_playlist_position" ON public.playlist_items USING btree ("playlistId", "position");

CREATE INDEX "IDX_playlist_saves_user" ON public.playlist_saves USING btree ("userId");

CREATE INDEX "IDX_playlist_shares_playlistId" ON public.playlist_shares USING btree ("playlistId");

CREATE INDEX "IDX_playlist_shares_userId" ON public.playlist_shares USING btree ("userId");

CREATE INDEX "IDX_playlists_ownerId" ON public.playlists USING btree ("ownerId");

CREATE INDEX "IDX_refresh_tokens_tokenHash" ON public.refresh_tokens USING btree ("tokenHash");

CREATE INDEX "IDX_refresh_tokens_userId" ON public.refresh_tokens USING btree ("userId");

CREATE INDEX "IDX_subtitle_files_mediaFileId" ON public.subtitle_files USING btree ("mediaFileId");

CREATE INDEX "IDX_subtitle_files_mediaId" ON public.subtitle_files USING btree ("mediaId");

CREATE INDEX "IDX_user_follows_follower" ON public.user_follows USING btree ("followerId");

CREATE INDEX "IDX_user_follows_following" ON public.user_follows USING btree ("followingId");

CREATE UNIQUE INDEX "UQ_likes_episode" ON public.likes USING btree ("userId", "episodeId") WHERE ("episodeId" IS NOT NULL);

CREATE UNIQUE INDEX "UQ_likes_movie" ON public.likes USING btree ("userId", "mediaId") WHERE (("seasonId" IS NULL) AND ("episodeId" IS NULL));

CREATE UNIQUE INDEX "UQ_likes_season" ON public.likes USING btree ("userId", "seasonId") WHERE ("seasonId" IS NOT NULL);

CREATE UNIQUE INDEX "UQ_livetv_group_access_user_group" ON public.livetv_group_access USING btree ("userId", "groupName");

CREATE UNIQUE INDEX "UQ_livetv_guide_channel_source_id" ON public.livetv_guide_channels USING btree ("guideSourceId", "channelId");

CREATE UNIQUE INDEX "UQ_livetv_pref_user_channel" ON public.livetv_user_channel_prefs USING btree ("userId", "channelId");

CREATE UNIQUE INDEX "UQ_livetv_stream_source_external" ON public.livetv_channel_streams USING btree ("sourceId", "externalId");

CREATE UNIQUE INDEX "UQ_media_file_scans_media_file" ON public.media_file_scans USING btree ("mediaFileId");

CREATE UNIQUE INDEX "UQ_media_type_tmdbId" ON public.media USING btree (type, "tmdbId");

CREATE UNIQUE INDEX "UQ_playlist_items_episode" ON public.playlist_items USING btree ("playlistId", "episodeId") WHERE ("episodeId" IS NOT NULL);

CREATE UNIQUE INDEX "UQ_playlist_items_movie" ON public.playlist_items USING btree ("playlistId", "mediaId") WHERE ("episodeId" IS NULL);

CREATE UNIQUE INDEX "UQ_recommendation_dismissals_user_media" ON public.recommendation_dismissals USING btree ("userId", "mediaId");

CREATE INDEX idx_episodes_season_hasfile_end ON public.episodes USING btree ("seasonId", "hasFile", "endEpisodeNumber");

CREATE UNIQUE INDEX idx_playback_user_episode ON public.playback_states USING btree ("userId", "episodeId") WHERE ("episodeId" IS NOT NULL);

CREATE UNIQUE INDEX idx_playback_user_movie ON public.playback_states USING btree ("userId", "mediaId") WHERE ("episodeId" IS NULL);

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "FK_060071713679f7fee42720c6753" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subtitle_provider_stats
    ADD CONSTRAINT "FK_0bd2f50e4e0a883545fde657094" FOREIGN KEY ("providerId") REFERENCES public.subtitle_providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_0f9dbadfd3458af1e6bc49c93e3" FOREIGN KEY ("addedById") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "FK_1127dccf41a2959b675a0aa8891" FOREIGN KEY ("defaultQualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_16f8c7b6e4824b9ccca31b9616b" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_1a5c30e99b5283b5653ee29b6b5" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_1a6417072770a4914bd315ab750" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_295bae34d5648dd18b16747db4a" FOREIGN KEY ("translationProviderId") REFERENCES public.translation_providers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_2e975a73e827bc421da61575b7a" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "FK_32958f30dee035e832a2234763d" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "FK_368e146b785b574f42ae9e53d5e" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_38e603e48e77e016bc9cc88cafd" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_4340ea3e8eb488c8cb4edbcc468" FOREIGN KEY ("qualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_461751303606d68d0c5666347d7" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "FK_59af5c2b4a5f3029361bda58aff" FOREIGN KEY ("channelId") REFERENCES public.livetv_channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "FK_5d4f9a22dd268ce08eb2319d0c8" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT "FK_5e53591a9fd2dbb7f297863ecc6" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "FK_62c91d23418a7ae8115f07f64d9" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "FK_62d457c000de0f01b2821a06ae6" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "FK_6300484b604263eaae8a6aab88d" FOREIGN KEY ("followerId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "FK_642c4b48b2c022d0baae6cc1226" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "FK_644d5c1672d256a02073eec76d6" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_65ef9a90fa855c14dd0cd896c8b" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_67214b2270f001c5a96a3626315" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "FK_68b96c817fab521697d7a087685" FOREIGN KEY ("defaultLanguageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_6ac8127d11e259d8feb3a1c77c4" FOREIGN KEY ("languageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "FK_6b32aaee05883e7fc772e29db28" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "FK_6cc8df2e63ef1cd8cf28bfc854a" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_6cde0e5015d20edcd45f593d27b" FOREIGN KEY ("qualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_724fe2622945e05c195981e5093" FOREIGN KEY ("addedById") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_742bc2fe139bc8334edab814e16" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "FK_7c1c468ee5ade7295749ab9e1e9" FOREIGN KEY ("sourceId") REFERENCES public.livetv_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "FK_7c6c27f12c4e972eab4b3aaccbf" FOREIGN KEY ("followingId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "FK_7f3a35a769725163823e1162a98" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "FK_8226529bf8b570cefa0bad2f96a" FOREIGN KEY ("personId") REFERENCES public.persons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "FK_83f2ec25950f32fb4930d0b733f" FOREIGN KEY ("requestId") REFERENCES public.requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_868d7ead9d6748409edee2b7b4a" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_8b1354ded3e5cd533bc0d04ce18" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_93dd6ea962d8a48df3f7448bdd5" FOREIGN KEY ("approvedById") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "FK_957d1f3537c85497076254ac1e8" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "FK_95c3254f4a9023b7f30c81c25fa" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.livetv_guide_channels
    ADD CONSTRAINT "FK_9919469c4f149762ee9c3265564" FOREIGN KEY ("guideSourceId") REFERENCES public.livetv_guide_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_9dcd364d418c539e74b7f57ad36" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_9fd8637cb821ddec6f57b422785" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_a28f439c529ee2c6540d329e544" FOREIGN KEY ("senderId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playlists
    ADD CONSTRAINT "FK_aa5d498a2f045be2fb71ef98d45" FOREIGN KEY ("ownerId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_file_scans
    ADD CONSTRAINT "FK_af6e69aca953537e68d29c82d0c" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_b01f3bfb9c8dcbca9c0030341b3" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT "FK_b312e9d94c9b80adee2330b73e9" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT "FK_b4ef632c24f24a5e7b9c4e18a4e" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_badc34ed0e95631af673a5d981d" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_be846ad4b43f40acc7034ef7f40" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_bf4a42ddf842b0536fcd81b4f2b" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "FK_c03e315afb98705e644633d80b7" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_c6cb47d29a66465e0489a770be8" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.livetv_group_access
    ADD CONSTRAINT "FK_c8018529d697ca2f8b6db09a809" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_cfd8e81fac09d7339a32e57d904" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_d9b24c2cc987bf39be9bd481fc5" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "FK_d9ebcae21d44cc576a4f569486d" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subtitle_blacklist
    ADD CONSTRAINT "FK_e0508dc1dd297c4cc01044f228c" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.livetv_programs
    ADD CONSTRAINT "FK_e286f77ce01c33b14526a8090d7" FOREIGN KEY ("guideSourceId") REFERENCES public.livetv_guide_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.livetv_guide_sources
    ADD CONSTRAINT "FK_e84c176ef1ef24a8c523d86bc95" FOREIGN KEY ("sourceId") REFERENCES public.livetv_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_ee17496f10af9bad93ad1b94f2d" FOREIGN KEY ("recipientId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "FK_f4cc72c18df00113d4e17fa598c" FOREIGN KEY ("channelId") REFERENCES public.livetv_channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "FK_f702d61f4cd1578c889ab3cadca" FOREIGN KEY ("personId") REFERENCES public.persons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_fad8b97f2b3863e76aae917e94d" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_fb0eb80298f112ac0bfb103da0e" FOREIGN KEY ("languageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "FK_fe0902ebcd7a31e03080d4bf4af" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.playback_qoe_events
    ADD CONSTRAINT "FK_playback_qoe_events_session" FOREIGN KEY ("sessionId") REFERENCES public.playback_qoe_sessions("sessionId") ON DELETE CASCADE;

INSERT INTO public.migrations VALUES (1, 1777816212948, 'Baseline1777816212948');
INSERT INTO public.migrations VALUES (2, 1777886651743, 'DropProviderKeySettings1777886651743');
INSERT INTO public.migrations VALUES (3, 1777887905078, 'DeleteOrphanSeriesMediaFiles1777887905078');
INSERT INTO public.migrations VALUES (4, 1778011000000, 'DropStreamingSegmentFormat1778011000000');
INSERT INTO public.migrations VALUES (5, 1778115000000, 'DropStreamingQsvTuningKnobs1778115000000');
INSERT INTO public.migrations VALUES (6, 1778200000000, 'AddMediaAddedBy1778200000000');
INSERT INTO public.migrations VALUES (7, 1778300000000, 'BackfillMediaLanguageProfile1778300000000');
INSERT INTO public.migrations VALUES (8, 1778400000000, 'AddMediaAlternativeTitles1778400000000');
INSERT INTO public.migrations VALUES (9, 1778500000000, 'AddIndexerCapsSearchFallback1778500000000');
INSERT INTO public.migrations VALUES (10, 1778600000000, 'AddMediaTmdbCollection1778600000000');
INSERT INTO public.migrations VALUES (11, 1778700000000, 'AddIndexerRequestDelay1778700000000');
INSERT INTO public.migrations VALUES (12, 1778800000000, 'AddSeasonPosterUrl1778800000000');
INSERT INTO public.migrations VALUES (13, 1778900000000, 'AddMediaAdditionalFanartUrls1778900000000');
INSERT INTO public.migrations VALUES (14, 1779000000000, 'BackfillDiskSubtitleScore1779000000000');
INSERT INTO public.migrations VALUES (15, 1779100000000, 'CollapseLibraryRootFolders1779100000000');
INSERT INTO public.migrations VALUES (16, 1779200000000, 'InlineLibraryPath1779200000000');
INSERT INTO public.migrations VALUES (17, 1779300000000, 'AddMediaFileOsdbHash1779300000000');
INSERT INTO public.migrations VALUES (18, 1779310000000, 'AddSubtitleFileHashMatched1779310000000');
INSERT INTO public.migrations VALUES (19, 1779400000000, 'AddDownloadHistoryEpisodeSeason1779400000000');
INSERT INTO public.migrations VALUES (20, 1779500000000, 'CollapseLegacyHistoryDuplicates1779500000000');
INSERT INTO public.migrations VALUES (21, 1779600000000, 'CreateRefreshTokens1779600000000');
INSERT INTO public.migrations VALUES (22, 1779700000000, 'AddRequestPosterFanartUrls1779700000000');
INSERT INTO public.migrations VALUES (23, 1779800000000, 'AddMediaLogoUrl1779800000000');
INSERT INTO public.migrations VALUES (24, 1780200000000, 'AddOcrSubtitleEnumValues1780200000000');
INSERT INTO public.migrations VALUES (25, 1780300000000, 'AddSubtitleSourceStreamIndex1780300000000');
INSERT INTO public.migrations VALUES (26, 1780400000000, 'NormalizeSubtitleLanguageCodes1780400000000');
INSERT INTO public.migrations VALUES (27, 1780500000000, 'AddQualityProfileResolutionUpgradeOnly1780500000000');
INSERT INTO public.migrations VALUES (28, 1781000000000, 'AddPairingSystemName1781000000000');
INSERT INTO public.migrations VALUES (29, 1781100000000, 'AddUserLibraryPrefs1781100000000');
INSERT INTO public.migrations VALUES (30, 1781200000000, 'CreatePlaylists1781200000000');
INSERT INTO public.migrations VALUES (31, 1781300000000, 'AddPlaylistAutoPlay1781300000000');
INSERT INTO public.migrations VALUES (32, 1781400000000, 'AddSocialFeature1781400000000');
INSERT INTO public.migrations VALUES (33, 1781500000000, 'AddPlaylistSaves1781500000000');
INSERT INTO public.migrations VALUES (34, 1781600000000, 'AddLikes1781600000000');
INSERT INTO public.migrations VALUES (35, 1781700000000, 'AddContentRecommendations1781700000000');
INSERT INTO public.migrations VALUES (36, 1781800000000, 'AddShareDisabled1781800000000');
INSERT INTO public.migrations VALUES (37, 1781900000000, 'AddShareStats1781900000000');
INSERT INTO public.migrations VALUES (38, 1782000000000, 'AddRequestKind1782000000000');
INSERT INTO public.migrations VALUES (39, 1782100000000, 'AddLibraryMetadataLanguage1782100000000');
INSERT INTO public.migrations VALUES (40, 1782200000000, 'AddTranslatedSubtitleProviderType1782200000000');
INSERT INTO public.migrations VALUES (41, 1782300000000, 'CreateTranslationProviders1782300000000');
INSERT INTO public.migrations VALUES (42, 1782400000000, 'AddSubtitleTranslationProviderName1782400000000');
INSERT INTO public.migrations VALUES (43, 1782500000000, 'AddSeasonOverviewAirDate1782500000000');
INSERT INTO public.migrations VALUES (44, 1782600000000, 'AddBlocklistSourceTitleUniqueIndex1782600000000');
INSERT INTO public.migrations VALUES (45, 1782700000000, 'DropBlocklistIndexerFk1782700000000');
INSERT INTO public.migrations VALUES (46, 1782800000000, 'CreatePluginTables1782800000000');
INSERT INTO public.migrations VALUES (47, 1782900000000, 'AddPluginPackageStatusReason1782900000000');
INSERT INTO public.migrations VALUES (48, 1783000000000, 'AlignTimestampColumnsToTimestamptz1783000000000');
INSERT INTO public.migrations VALUES (49, 1783100000000, 'SeedOfficialPluginSource1783100000000');
INSERT INTO public.migrations VALUES (50, 1783200000000, 'DropCleanupProfiles1783200000000');
INSERT INTO public.migrations VALUES (51, 1783300000000, 'DropAcquisitionTables1783300000000');
INSERT INTO public.migrations VALUES (52, 1783400000000, 'IndexPlaybackStateUniquePerTarget1783400000000');
INSERT INTO public.migrations VALUES (53, 1783500000000, 'AddPluginPackageEnabled1783500000000');
INSERT INTO public.migrations VALUES (54, 1783600000000, 'DropPluginRegistrationEnabled1783600000000');
INSERT INTO public.migrations VALUES (55, 1783700000000, 'IndexEpisodesSeasonId1783700000000');
INSERT INTO public.migrations VALUES (56, 1783800000000, 'AddPluginRegistrationChildUid1783800000000');
INSERT INTO public.migrations VALUES (57, 1783900000000, 'NormalizeNotificationEndpointKey1783900000000');
INSERT INTO public.migrations VALUES (58, 1784000000000, 'DropDelayProfiles1784000000000');
INSERT INTO public.migrations VALUES (59, 1784100000000, 'AlignForeignKeyNamesWithEntityMetadata1784100000000');
INSERT INTO public.migrations VALUES (60, 1784200000000, 'AutoApprovalCriteria1784200000000');
INSERT INTO public.migrations VALUES (61, 1784300000000, 'AddHideSpoilers1784300000000');
INSERT INTO public.migrations VALUES (62, 1784400000000, 'AddRemoteControlPermissions1784400000000');
INSERT INTO public.migrations VALUES (63, 1784500000000, 'AddRemoteControlGrants1784500000000');
INSERT INTO public.migrations VALUES (64, 1784600000000, 'CustomFormatSpecsAndMinScore1784600000000');
INSERT INTO public.migrations VALUES (65, 1784700000000, 'IndexSubtitleFilesMedia1784700000000');
INSERT INTO public.migrations VALUES (66, 1784800000000, 'AddSubtitleErrorMessage1784800000000');
INSERT INTO public.migrations VALUES (67, 1784900000000, 'AddSubtitleSyncFailed1784900000000');
INSERT INTO public.migrations VALUES (68, 1785000000000, 'QualityDefinitionMinSizes1785000000000');
INSERT INTO public.migrations VALUES (69, 1785100000000, 'ScopePersonIdsByProvider1785100000000');
INSERT INTO public.migrations VALUES (70, 1785200000000, 'SplitRolesManagePermission1785200000000');
INSERT INTO public.migrations VALUES (71, 1785300000000, 'DropDefaultLibraryFlags1785300000000');
INSERT INTO public.migrations VALUES (72, 1785400000000, 'LivetvTables1785400000000');
INSERT INTO public.migrations VALUES (73, 1785500000000, 'IndexLivetvChannelStreamsChannel1785500000000');
INSERT INTO public.migrations VALUES (74, 1785600000000, 'NormaliseLivetvGroupNames1785600000000');
INSERT INTO public.migrations VALUES (75, 1785700000000, 'AddLivetvAdultGuardError1785700000000');
INSERT INTO public.migrations VALUES (76, 1785800000000, 'FixLivetvLogoPathRoute1785800000000');
INSERT INTO public.migrations VALUES (77, 1785900000000, 'AddMediaFileScans1785900000000');
INSERT INTO public.migrations VALUES (78, 1786000000000, 'AddEdlSupport1786000000000');
INSERT INTO public.migrations VALUES (79, 1786100000000, 'CanonicalizeSubtitleLanguageCodes1786100000000');
INSERT INTO public.migrations VALUES (80, 1786200000000, 'DropUnrenderableSidecarSubtitles1786200000000');
INSERT INTO public.migrations VALUES (81, 1786300000000, 'CreatePlaybackQoe1786300000000');

SELECT pg_catalog.setval('public.migrations_id_seq', 81, true);


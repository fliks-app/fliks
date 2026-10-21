--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: media_servers_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_servers_type_enum AS ENUM (
    'local',
    'jellyfin',
    'emby',
    'plex'
);


--
-- Name: media_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_status_enum AS ENUM (
    'tba',
    'announced',
    'released',
    'ended',
    'continuing',
    'deleted'
);


--
-- Name: media_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_type_enum AS ENUM (
    'movie',
    'series'
);


--
-- Name: playlist_shares_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.playlist_shares_role_enum AS ENUM (
    'viewer',
    'editor',
    'administrator'
);


--
-- Name: playlists_visibility_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.playlists_visibility_enum AS ENUM (
    'private',
    'followers',
    'public'
);


--
-- Name: plugin_packages_origin_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plugin_packages_origin_enum AS ENUM (
    'catalog',
    'manual'
);


--
-- Name: plugin_packages_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plugin_packages_status_enum AS ENUM (
    'active',
    'failed'
);


--
-- Name: requests_kind_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.requests_kind_enum AS ENUM (
    'add',
    'delete'
);


--
-- Name: requests_mediatype_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.requests_mediatype_enum AS ENUM (
    'movie',
    'series'
);


--
-- Name: requests_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.requests_status_enum AS ENUM (
    'pending',
    'approved',
    'declined',
    'processing',
    'available',
    'failed'
);


--
-- Name: subtitle_files_providertype_enum; Type: TYPE; Schema: public; Owner: -
--

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


--
-- Name: subtitle_files_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subtitle_files_status_enum AS ENUM (
    'missing',
    'downloaded',
    'upgraded',
    'synced',
    'failed',
    'embedded',
    'processing'
);


--
-- Name: subtitle_providers_type_enum; Type: TYPE; Schema: public; Owner: -
--

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


--
-- Name: translation_providers_engine_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.translation_providers_engine_enum AS ENUM (
    'gemini',
    'openai',
    'libretranslate'
);


--
-- Name: user_follows_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_follows_status_enum AS ENUM (
    'pending',
    'accepted'
);


--
-- Name: users_mediaservertype_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.users_mediaservertype_enum AS ENUM (
    'local',
    'jellyfin',
    'emby',
    'plex'
);


--
-- Name: users_profilevisibility_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.users_profilevisibility_enum AS ENUM (
    'public',
    'private'
);


--
-- Name: iso_ms(timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.iso_ms(timestamp without time zone) RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $_$
  SELECT to_char($1, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$_$;


--
-- Name: iso_ms(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.iso_ms(timestamp with time zone) RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $_$
  SELECT to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$_$;


--
-- Name: media_search_vector_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_search_vector_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('french', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('french', COALESCE(NEW."originalTitle", '')), 'B') ||
    setweight(to_tsvector('french', COALESCE(NEW.overview, '')), 'C');
  RETURN NEW;
END $$;


--
-- Name: persons_search_vector_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persons_search_vector_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.name);
  RETURN NEW;
END $$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt" THEN
    NEW."updatedAt" = now();
  END IF;
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _sqlx_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._sqlx_migrations (
    version bigint NOT NULL,
    description text NOT NULL,
    installed_on timestamp with time zone DEFAULT now() NOT NULL,
    success boolean NOT NULL,
    checksum bytea NOT NULL,
    execution_time bigint NOT NULL
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    key character varying NOT NULL,
    value text
);


--
-- Name: app_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_settings_id_seq OWNED BY public.app_settings.id;


--
-- Name: auto_approval_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_approval_rules (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    criteria jsonb NOT NULL
);


--
-- Name: auto_approval_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_approval_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_approval_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_approval_rules_id_seq OWNED BY public.auto_approval_rules.id;


--
-- Name: cleanup_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleanup_candidates (
    "mediaId" integer NOT NULL,
    "ruleId" integer NOT NULL,
    "flaggedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "deleteAt" timestamp with time zone,
    id integer NOT NULL,
    "seasonId" integer,
    "episodeId" integer,
    "lastReminderDays" integer
);


--
-- Name: cleanup_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cleanup_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cleanup_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cleanup_candidates_id_seq OWNED BY public.cleanup_candidates.id;


--
-- Name: cleanup_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleanup_exclusions (
    "mediaId" integer NOT NULL,
    "userId" integer,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    id integer NOT NULL,
    "seasonId" integer,
    "episodeId" integer
);


--
-- Name: cleanup_exclusions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cleanup_exclusions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cleanup_exclusions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cleanup_exclusions_id_seq OWNED BY public.cleanup_exclusions.id;


--
-- Name: cleanup_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleanup_rules (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    criteria jsonb NOT NULL,
    action text DEFAULT 'delete'::text NOT NULL,
    "graceDays" integer,
    level text DEFAULT 'movie'::text NOT NULL,
    "deleteSeriesWhenEmpty" boolean DEFAULT false NOT NULL,
    "reminderDays" integer[] DEFAULT '{7,1}'::integer[] NOT NULL,
    CONSTRAINT cleanup_rules_action_check CHECK ((action = ANY (ARRAY['delete'::text, 'delete_files_unmonitor'::text, 'none'::text]))),
    CONSTRAINT "cleanup_rules_graceDays_check" CHECK (("graceDays" >= 0)),
    CONSTRAINT cleanup_rules_level_check CHECK ((level = ANY (ARRAY['movie'::text, 'series'::text, 'season'::text, 'episode'::text])))
);


--
-- Name: cleanup_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cleanup_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cleanup_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cleanup_rules_id_seq OWNED BY public.cleanup_rules.id;


--
-- Name: commands; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: commands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.commands_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: commands_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.commands_id_seq OWNED BY public.commands.id;


--
-- Name: content_recommendations; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: content_recommendations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_recommendations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_recommendations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_recommendations_id_seq OWNED BY public.content_recommendations.id;


--
-- Name: custom_formats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_formats (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    specs jsonb DEFAULT '[]'::jsonb CONSTRAINT custom_formats_specifications_not_null NOT NULL
);


--
-- Name: custom_formats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_formats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_formats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_formats_id_seq OWNED BY public.custom_formats.id;


--
-- Name: episode_markers; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: episode_markers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.episode_markers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: episode_markers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.episode_markers_id_seq OWNED BY public.episode_markers.id;


--
-- Name: episodes; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.episodes_id_seq OWNED BY public.episodes.id;


--
-- Name: language_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.language_profiles (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    "audioLanguages" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "subtitleLanguages" jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: language_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.language_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: language_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.language_profiles_id_seq OWNED BY public.language_profiles.id;


--
-- Name: libraries; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: libraries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.libraries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: libraries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.libraries_id_seq OWNED BY public.libraries.id;


--
-- Name: library_user_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_user_access (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "libraryId" integer,
    "userId" integer
);


--
-- Name: library_user_access_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.library_user_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: library_user_access_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.library_user_access_id_seq OWNED BY public.library_user_access.id;


--
-- Name: likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.likes (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "mediaId" integer NOT NULL,
    "seasonId" integer,
    "episodeId" integer
);


--
-- Name: likes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: likes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.likes_id_seq OWNED BY public.likes.id;


--
-- Name: livetv_channel_streams; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_channel_streams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_channel_streams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_channel_streams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_channel_streams_id_seq OWNED BY public.livetv_channel_streams.id;


--
-- Name: livetv_channels; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_channels_id_seq OWNED BY public.livetv_channels.id;


--
-- Name: livetv_group_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.livetv_group_access (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "groupName" character varying NOT NULL,
    "userId" integer
);


--
-- Name: livetv_group_access_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_group_access_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_group_access_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_group_access_id_seq OWNED BY public.livetv_group_access.id;


--
-- Name: livetv_guide_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.livetv_guide_channels (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "channelId" character varying NOT NULL,
    "displayNames" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "iconUrl" text,
    "guideSourceId" integer
);


--
-- Name: livetv_guide_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_guide_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_guide_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_guide_channels_id_seq OWNED BY public.livetv_guide_channels.id;


--
-- Name: livetv_guide_sources; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_guide_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_guide_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_guide_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_guide_sources_id_seq OWNED BY public.livetv_guide_sources.id;


--
-- Name: livetv_programs; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_programs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_programs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_programs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_programs_id_seq OWNED BY public.livetv_programs.id;


--
-- Name: livetv_sources; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_sources_id_seq OWNED BY public.livetv_sources.id;


--
-- Name: livetv_user_channel_prefs; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: livetv_user_channel_prefs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livetv_user_channel_prefs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livetv_user_channel_prefs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livetv_user_channel_prefs_id_seq OWNED BY public.livetv_user_channel_prefs.id;


--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: media_cast; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_cast (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "character" character varying NOT NULL,
    "order" integer NOT NULL,
    "mediaId" integer,
    "personId" integer
);


--
-- Name: media_cast_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_cast_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_cast_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_cast_id_seq OWNED BY public.media_cast.id;


--
-- Name: media_crew; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_crew (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    job character varying NOT NULL,
    department character varying NOT NULL,
    "mediaId" integer,
    "personId" integer
);


--
-- Name: media_crew_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_crew_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_crew_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_crew_id_seq OWNED BY public.media_crew.id;


--
-- Name: media_file_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_file_scans (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "mediaFileId" integer NOT NULL,
    size bigint NOT NULL,
    "mtimeMs" double precision NOT NULL,
    scan jsonb NOT NULL
);


--
-- Name: media_file_scans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_file_scans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_file_scans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_file_scans_id_seq OWNED BY public.media_file_scans.id;


--
-- Name: media_files; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: media_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_files_id_seq OWNED BY public.media_files.id;


--
-- Name: media_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_id_seq OWNED BY public.media.id;


--
-- Name: media_metadata; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: media_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_metadata_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_metadata_id_seq OWNED BY public.media_metadata.id;


--
-- Name: media_servers; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: media_servers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_servers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_servers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_servers_id_seq OWNED BY public.media_servers.id;


--
-- Name: notification_connections; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: notification_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_connections_id_seq OWNED BY public.notification_connections.id;


--
-- Name: pairing_requests; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: pairing_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pairing_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pairing_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pairing_requests_id_seq OWNED BY public.pairing_requests.id;


--
-- Name: persons; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: persons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.persons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: persons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.persons_id_seq OWNED BY public.persons.id;


--
-- Name: playback_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playback_history (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "mediaId" integer NOT NULL,
    "episodeId" integer,
    "playedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playback_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playback_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playback_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playback_history_id_seq OWNED BY public.playback_history.id;


--
-- Name: playback_qoe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playback_qoe_events (
    id integer NOT NULL,
    "sessionId" character varying(64) NOT NULL,
    at timestamp with time zone NOT NULL,
    type character varying NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: playback_qoe_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playback_qoe_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playback_qoe_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playback_qoe_events_id_seq OWNED BY public.playback_qoe_events.id;


--
-- Name: playback_qoe_sessions; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: playback_states; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: playback_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playback_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playback_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playback_states_id_seq OWNED BY public.playback_states.id;


--
-- Name: playlist_items; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: playlist_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playlist_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playlist_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playlist_items_id_seq OWNED BY public.playlist_items.id;


--
-- Name: playlist_saves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playlist_saves (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "playlistId" integer NOT NULL
);


--
-- Name: playlist_saves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playlist_saves_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playlist_saves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playlist_saves_id_seq OWNED BY public.playlist_saves.id;


--
-- Name: playlist_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playlist_shares (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "playlistId" integer NOT NULL,
    "userId" integer NOT NULL,
    role public.playlist_shares_role_enum DEFAULT 'viewer'::public.playlist_shares_role_enum NOT NULL
);


--
-- Name: playlist_shares_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playlist_shares_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playlist_shares_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playlist_shares_id_seq OWNED BY public.playlist_shares.id;


--
-- Name: playlists; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: playlists_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playlists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playlists_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playlists_id_seq OWNED BY public.playlists.id;


--
-- Name: plugin_packages; Type: TABLE; Schema: public; Owner: -
--

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
    enabled boolean DEFAULT true NOT NULL,
    "networkInternal" boolean DEFAULT false NOT NULL,
    "cwasmSha256" text,
    "cwasmEngine" text
);


--
-- Name: plugin_packages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plugin_packages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plugin_packages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plugin_packages_id_seq OWNED BY public.plugin_packages.id;


--
-- Name: plugin_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_registrations (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "pluginId" character varying NOT NULL,
    "ingestRoots" text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    manifest jsonb NOT NULL
);


--
-- Name: plugin_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plugin_registrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plugin_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plugin_registrations_id_seq OWNED BY public.plugin_registrations.id;


--
-- Name: plugin_scheduled_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_scheduled_calls (
    "pluginId" text NOT NULL,
    key text NOT NULL,
    "runAt" timestamp with time zone NOT NULL,
    payload text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    version bigint NOT NULL
);


--
-- Name: plugin_scheduled_calls_version_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plugin_scheduled_calls_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plugin_sources; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: plugin_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plugin_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plugin_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plugin_sources_id_seq OWNED BY public.plugin_sources.id;


--
-- Name: quality_definitions; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: quality_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quality_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quality_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quality_definitions_id_seq OWNED BY public.quality_definitions.id;


--
-- Name: quality_profiles; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: quality_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quality_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quality_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quality_profiles_id_seq OWNED BY public.quality_profiles.id;


--
-- Name: recommendation_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recommendation_dismissals (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" integer NOT NULL,
    "mediaId" integer NOT NULL
);


--
-- Name: recommendation_dismissals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recommendation_dismissals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recommendation_dismissals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recommendation_dismissals_id_seq OWNED BY public.recommendation_dismissals.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;


--
-- Name: remote_control_grants; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: remote_control_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.remote_control_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_control_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.remote_control_grants_id_seq OWNED BY public.remote_control_grants.id;


--
-- Name: request_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_comments (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    message text NOT NULL,
    "requestId" integer,
    "userId" integer
);


--
-- Name: request_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.request_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: request_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.request_comments_id_seq OWNED BY public.request_comments.id;


--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.requests_id_seq OWNED BY public.requests.id;


--
-- Name: role_default_libraries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_default_libraries (
    "roleId" integer NOT NULL,
    "libraryId" integer NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying NOT NULL,
    permissions text DEFAULT '[]'::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: seasons; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: seasons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.seasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.seasons_id_seq OWNED BY public.seasons.id;


--
-- Name: subtitle_blacklist; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: subtitle_blacklist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subtitle_blacklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subtitle_blacklist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subtitle_blacklist_id_seq OWNED BY public.subtitle_blacklist.id;


--
-- Name: subtitle_files; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: subtitle_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subtitle_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subtitle_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subtitle_files_id_seq OWNED BY public.subtitle_files.id;


--
-- Name: subtitle_provider_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subtitle_provider_stats (
    id integer NOT NULL,
    "queryDate" timestamp without time zone DEFAULT now() NOT NULL,
    "queryType" character varying DEFAULT 'search'::character varying NOT NULL,
    "responseTimeMs" integer DEFAULT 0 NOT NULL,
    "resultCount" integer DEFAULT 0 NOT NULL,
    "errorMessage" text,
    "providerId" integer
);


--
-- Name: subtitle_provider_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subtitle_provider_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subtitle_provider_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subtitle_provider_stats_id_seq OWNED BY public.subtitle_provider_stats.id;


--
-- Name: subtitle_providers; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: subtitle_providers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subtitle_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subtitle_providers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subtitle_providers_id_seq OWNED BY public.subtitle_providers.id;


--
-- Name: translation_providers; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: translation_providers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.translation_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: translation_providers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.translation_providers_id_seq OWNED BY public.translation_providers.id;


--
-- Name: user_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_follows (
    id integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "followerId" integer NOT NULL,
    "followingId" integer NOT NULL,
    status public.user_follows_status_enum DEFAULT 'accepted'::public.user_follows_status_enum NOT NULL
);


--
-- Name: user_follows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_follows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_follows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_follows_id_seq OWNED BY public.user_follows.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: app_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings ALTER COLUMN id SET DEFAULT nextval('public.app_settings_id_seq'::regclass);


--
-- Name: auto_approval_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_approval_rules ALTER COLUMN id SET DEFAULT nextval('public.auto_approval_rules_id_seq'::regclass);


--
-- Name: cleanup_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates ALTER COLUMN id SET DEFAULT nextval('public.cleanup_candidates_id_seq'::regclass);


--
-- Name: cleanup_exclusions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions ALTER COLUMN id SET DEFAULT nextval('public.cleanup_exclusions_id_seq'::regclass);


--
-- Name: cleanup_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_rules ALTER COLUMN id SET DEFAULT nextval('public.cleanup_rules_id_seq'::regclass);


--
-- Name: commands id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands ALTER COLUMN id SET DEFAULT nextval('public.commands_id_seq'::regclass);


--
-- Name: content_recommendations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations ALTER COLUMN id SET DEFAULT nextval('public.content_recommendations_id_seq'::regclass);


--
-- Name: custom_formats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_formats ALTER COLUMN id SET DEFAULT nextval('public.custom_formats_id_seq'::regclass);


--
-- Name: episode_markers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_markers ALTER COLUMN id SET DEFAULT nextval('public.episode_markers_id_seq'::regclass);


--
-- Name: episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes ALTER COLUMN id SET DEFAULT nextval('public.episodes_id_seq'::regclass);


--
-- Name: language_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_profiles ALTER COLUMN id SET DEFAULT nextval('public.language_profiles_id_seq'::regclass);


--
-- Name: libraries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries ALTER COLUMN id SET DEFAULT nextval('public.libraries_id_seq'::regclass);


--
-- Name: library_user_access id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_user_access ALTER COLUMN id SET DEFAULT nextval('public.library_user_access_id_seq'::regclass);


--
-- Name: likes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes ALTER COLUMN id SET DEFAULT nextval('public.likes_id_seq'::regclass);


--
-- Name: livetv_channel_streams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channel_streams ALTER COLUMN id SET DEFAULT nextval('public.livetv_channel_streams_id_seq'::regclass);


--
-- Name: livetv_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channels ALTER COLUMN id SET DEFAULT nextval('public.livetv_channels_id_seq'::regclass);


--
-- Name: livetv_group_access id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_group_access ALTER COLUMN id SET DEFAULT nextval('public.livetv_group_access_id_seq'::regclass);


--
-- Name: livetv_guide_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_channels ALTER COLUMN id SET DEFAULT nextval('public.livetv_guide_channels_id_seq'::regclass);


--
-- Name: livetv_guide_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_sources ALTER COLUMN id SET DEFAULT nextval('public.livetv_guide_sources_id_seq'::regclass);


--
-- Name: livetv_programs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_programs ALTER COLUMN id SET DEFAULT nextval('public.livetv_programs_id_seq'::regclass);


--
-- Name: livetv_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_sources ALTER COLUMN id SET DEFAULT nextval('public.livetv_sources_id_seq'::regclass);


--
-- Name: livetv_user_channel_prefs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_user_channel_prefs ALTER COLUMN id SET DEFAULT nextval('public.livetv_user_channel_prefs_id_seq'::regclass);


--
-- Name: media id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media ALTER COLUMN id SET DEFAULT nextval('public.media_id_seq'::regclass);


--
-- Name: media_cast id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cast ALTER COLUMN id SET DEFAULT nextval('public.media_cast_id_seq'::regclass);


--
-- Name: media_crew id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_crew ALTER COLUMN id SET DEFAULT nextval('public.media_crew_id_seq'::regclass);


--
-- Name: media_file_scans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_scans ALTER COLUMN id SET DEFAULT nextval('public.media_file_scans_id_seq'::regclass);


--
-- Name: media_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files ALTER COLUMN id SET DEFAULT nextval('public.media_files_id_seq'::regclass);


--
-- Name: media_metadata id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_metadata ALTER COLUMN id SET DEFAULT nextval('public.media_metadata_id_seq'::regclass);


--
-- Name: media_servers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_servers ALTER COLUMN id SET DEFAULT nextval('public.media_servers_id_seq'::regclass);


--
-- Name: notification_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_connections ALTER COLUMN id SET DEFAULT nextval('public.notification_connections_id_seq'::regclass);


--
-- Name: pairing_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_requests ALTER COLUMN id SET DEFAULT nextval('public.pairing_requests_id_seq'::regclass);


--
-- Name: persons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons ALTER COLUMN id SET DEFAULT nextval('public.persons_id_seq'::regclass);


--
-- Name: playback_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history ALTER COLUMN id SET DEFAULT nextval('public.playback_history_id_seq'::regclass);


--
-- Name: playback_qoe_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_qoe_events ALTER COLUMN id SET DEFAULT nextval('public.playback_qoe_events_id_seq'::regclass);


--
-- Name: playback_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states ALTER COLUMN id SET DEFAULT nextval('public.playback_states_id_seq'::regclass);


--
-- Name: playlist_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items ALTER COLUMN id SET DEFAULT nextval('public.playlist_items_id_seq'::regclass);


--
-- Name: playlist_saves id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_saves ALTER COLUMN id SET DEFAULT nextval('public.playlist_saves_id_seq'::regclass);


--
-- Name: playlist_shares id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_shares ALTER COLUMN id SET DEFAULT nextval('public.playlist_shares_id_seq'::regclass);


--
-- Name: playlists id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlists ALTER COLUMN id SET DEFAULT nextval('public.playlists_id_seq'::regclass);


--
-- Name: plugin_packages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_packages ALTER COLUMN id SET DEFAULT nextval('public.plugin_packages_id_seq'::regclass);


--
-- Name: plugin_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_registrations ALTER COLUMN id SET DEFAULT nextval('public.plugin_registrations_id_seq'::regclass);


--
-- Name: plugin_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_sources ALTER COLUMN id SET DEFAULT nextval('public.plugin_sources_id_seq'::regclass);


--
-- Name: quality_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_definitions ALTER COLUMN id SET DEFAULT nextval('public.quality_definitions_id_seq'::regclass);


--
-- Name: quality_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_profiles ALTER COLUMN id SET DEFAULT nextval('public.quality_profiles_id_seq'::regclass);


--
-- Name: recommendation_dismissals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendation_dismissals ALTER COLUMN id SET DEFAULT nextval('public.recommendation_dismissals_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);


--
-- Name: remote_control_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_control_grants ALTER COLUMN id SET DEFAULT nextval('public.remote_control_grants_id_seq'::regclass);


--
-- Name: request_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_comments ALTER COLUMN id SET DEFAULT nextval('public.request_comments_id_seq'::regclass);


--
-- Name: requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests ALTER COLUMN id SET DEFAULT nextval('public.requests_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: seasons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons ALTER COLUMN id SET DEFAULT nextval('public.seasons_id_seq'::regclass);


--
-- Name: subtitle_blacklist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_blacklist ALTER COLUMN id SET DEFAULT nextval('public.subtitle_blacklist_id_seq'::regclass);


--
-- Name: subtitle_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files ALTER COLUMN id SET DEFAULT nextval('public.subtitle_files_id_seq'::regclass);


--
-- Name: subtitle_provider_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_provider_stats ALTER COLUMN id SET DEFAULT nextval('public.subtitle_provider_stats_id_seq'::regclass);


--
-- Name: subtitle_providers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_providers ALTER COLUMN id SET DEFAULT nextval('public.subtitle_providers_id_seq'::regclass);


--
-- Name: translation_providers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_providers ALTER COLUMN id SET DEFAULT nextval('public.translation_providers_id_seq'::regclass);


--
-- Name: user_follows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_follows ALTER COLUMN id SET DEFAULT nextval('public.user_follows_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: _sqlx_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public._sqlx_migrations (version, description, installed_on, success, checksum, execution_time) FROM stdin;
1777816212948	baseline	2026-01-01 00:00:00+00	t	\\xcd5d6b74ee0dec4f85a232a30eafffab05e89b7bbf4a9efc8cc74715ca30691777f4437f39e373087c2d3911d0bf50f6	0
1777886651743	drop-provider-key-settings	2026-01-01 00:00:00+00	t	\\x7fd66b6f233ea62482a14a12afaef1cf07c59bb6d4f7f301e24c5465a33ae5c612bb1914d39194ebc833ef2f373bad99	0
1777887905078	delete-orphan-series-media-files	2026-01-01 00:00:00+00	t	\\x990034eb7bcb80a8ff0d40d070b222298b78876424335366993d15da0168d484173b943e2f161d24d0b5734403665d9a	0
1778011000000	drop-streaming-segment-format	2026-01-01 00:00:00+00	t	\\x132c25c9d71f67762fc53be743d53f0445cc6d9f8d9b68a61bd8e3651289106e37329aafebee042483b185af5c906528	0
1778115000000	drop-streaming-qsv-tuning-knobs	2026-01-01 00:00:00+00	t	\\x6d80ff107b2e77bcc2ddca0f4bf354c36cb24086fc2996d557decf514d770bbaabfcdd29519c7e49c6dcc69a830ac172	0
1778200000000	add-media-added-by	2026-01-01 00:00:00+00	t	\\x531f0744382b4a12246217032fb26fb1a754b4962a9a534ecc4b63be34dcafd7e55bbaec160e4d3a0f39315468664f83	0
1778300000000	backfill-media-language-profile	2026-01-01 00:00:00+00	t	\\xa41fb75158edd701ac856a193e27c143d6403cb5a2898d02c85585df21f5b408fa376f4090363ab1e4c8fd32c7245b7a	0
1778400000000	add-media-alternative-titles	2026-01-01 00:00:00+00	t	\\xe4a0caf477653d6ded5c606c4993d5d90257017a1000a905c26305973c6471b71051dc90f0ce1642411aa6dd796090b1	0
1778500000000	add-indexer-caps-search-fallback	2026-01-01 00:00:00+00	t	\\x0f0b6d890aeeab7b1cb1ba845348fd9dac5dc6fbabd68120296ff9f3ab402a3edc6c16ed04538c23de2897632f192c71	0
1778600000000	add-media-tmdb-collection	2026-01-01 00:00:00+00	t	\\x09f31cd9b4ef6e9180ce07773a69a3764e0338f7cf2e0a6477a6d49d790f18dfe0797add2ffa1ea2c29ec832c211a570	0
1778700000000	add-indexer-request-delay	2026-01-01 00:00:00+00	t	\\xf12725eb78237fcc40c6f3fad0e28fa236514ee77289780e18bbef9f87ba38bf1dd2194f0ba9c3c55fca9c943e2a54ba	0
1778800000000	add-season-poster-url	2026-01-01 00:00:00+00	t	\\x3bc8db1250f88d34af7f161650d4433248c7193d38e521519a19d2762219cc6951dbaa8dcc62f1f14a945c9ba4e7de6b	0
1778900000000	add-media-additional-fanart-urls	2026-01-01 00:00:00+00	t	\\xd1f633f2448e59d3962f73b9ea5aadb2ee874cde90d3626128dbd58f865dd19ee0806a7eca8318ad94ae9dc6e21d7123	0
1779000000000	backfill-disk-subtitle-score	2026-01-01 00:00:00+00	t	\\x16de02b8a2b2f44976da156212dbf75f55e0fdbba6958071351664c1089d5662af99cc94588735f39d93427f50c5376b	0
1779100000000	collapse-library-root-folders	2026-01-01 00:00:00+00	t	\\x6ed371f449e45d022175341077339d1448c41c8d0342447667161c1a9b981cb3847af2c115084a95282c0372a3e68df2	0
1779200000000	inline-library-path	2026-01-01 00:00:00+00	t	\\xe6929486ceff310e7a9ab78307ba46675756b6b599270a2c85b8243fec0f1110b38a72f72024d63f66a18f1410969387	0
1779300000000	add-media-file-osdb-hash	2026-01-01 00:00:00+00	t	\\xcb097fd63a364a93eb9a6742782721f2b7111ff619421219c9eab1456694379ebcadc5144b0aa851f855f73c4b8c5cea	0
1779310000000	add-subtitle-file-hash-matched	2026-01-01 00:00:00+00	t	\\x3d1ed0dd70576fd08360d0925bf1d056823e506979ab322e68511eb6a558e1c7c5847f0efead6cae28cfbbdccd24bfb3	0
1779400000000	add-download-history-episode-season	2026-01-01 00:00:00+00	t	\\x75741a6fc8725cb0c07d76fb6d1537277eade009cfb6b8250b6fa23ccd3ecd96a9442105d1ee958b92e9b9366e931aa4	0
1779500000000	collapse-legacy-history-duplicates	2026-01-01 00:00:00+00	t	\\xe7ebde726b3b89c4f6e3cde80aca5bcf31ab2500097492d3fb3c89e931b514c1a0a6b8916ff7827d92c818b8f64480f7	0
1779600000000	create-refresh-tokens	2026-01-01 00:00:00+00	t	\\x010b5eb518086acbb9e6581127aafd08df8c3c08b31889fd18789fc774157a184738d61155d65e76fbcc33850e2943ef	0
1779700000000	add-request-poster-fanart-urls	2026-01-01 00:00:00+00	t	\\xa6a9e3a4c7c37f9ee4f26dff8383fd8b4c4828d85c0a69435a758e60fe9b9dd214c2085acbd8c421d790ea695e67b970	0
1779800000000	add-media-logo-url	2026-01-01 00:00:00+00	t	\\xef1f71c529a08648828facc9e4a79f0981c0038638d30ed3119fad34f7330ecb3fb7b4d002342463d709fe8f6bf66ab7	0
1780200000000	add-ocr-subtitle-enum-values	2026-01-01 00:00:00+00	t	\\xb8427f73b7765fa32006edebc2e59660fc509f19bdb94aadddde4ab34ff95aa557e06c4d1096671bd7ccc4e1fff377ae	0
1780300000000	add-subtitle-source-stream-index	2026-01-01 00:00:00+00	t	\\x9456a5500a0650ca4ad942e02b8ce187ee5d7ab36388ffd41dc2440167aa6a6c471e89f6ae87add4c5e33377a8717176	0
1780400000000	normalize-subtitle-language-codes	2026-01-01 00:00:00+00	t	\\x4e993db647288e780a241b2037d6409dbb1bb2fc69a3070d17a4f706480d93d7d47543fb8ebca741e7ecc1516a1f37ea	0
1780500000000	add-quality-profile-resolution-upgrade-only	2026-01-01 00:00:00+00	t	\\x5c8927bcf3176fe08c0c7438797fdb60c82b39367905593dffec8a038fd5aef1df44f474e26579c99a9da67b3917e7bb	0
1781000000000	add-pairing-system-name	2026-01-01 00:00:00+00	t	\\xdf8d01c7a761fbf21023addaca55c1a7d5e52276c0e24040a695de6b1cb25ee1f676bde463a39a00ae77bbe08feac397	0
1781100000000	add-user-library-prefs	2026-01-01 00:00:00+00	t	\\xc26b01d8e8e0e1c471d96dc139b7316120b917d21cd297f4712239481b30bacf1ba4ddbd647bb2b7a4c1bb06a6df983a	0
1781200000000	create-playlists	2026-01-01 00:00:00+00	t	\\x9738dd7fc3dba85b69289c43f33d4f88167bccb1bfdfa3fd376c81f9cbab3f6a3b210b11ba862bc860702bf2a14741e8	0
1781300000000	add-playlist-auto-play	2026-01-01 00:00:00+00	t	\\x3f48a543965c6893e1c267c69f3596f32cd74fe4664570186286d321f3c9ab8f3871b29c55565b4ad24980695a1b6735	0
1781400000000	add-social-feature	2026-01-01 00:00:00+00	t	\\x6dce443a1d60592eef93be6559f3c4f2c32429bf74ac1c35a54070af4b253bfa595d331a8d42443ddbab9f3f50be641e	0
1781500000000	add-playlist-saves	2026-01-01 00:00:00+00	t	\\xb22818f93d3de76a11cbbbda1e4a8f67f26149187deab664956dbcf38e8d7fafd5bd586280b83d81f7e8cfeeca443c5a	0
1781600000000	add-likes	2026-01-01 00:00:00+00	t	\\xc7eebae6bbb864aae4cd087d7b4a1db61f3e861e254d72cf0b8c23de74c16a8a7d0105503f8534925a4ef3806771f1b6	0
1781700000000	add-content-recommendations	2026-01-01 00:00:00+00	t	\\x5680dfab385e9407d8b556fd4bfaf9dd5453537ff0f7f330e447eedcc0952e511e0dbe7d22dd2a4b9e7a544dfb9064c4	0
1781800000000	add-share-disabled	2026-01-01 00:00:00+00	t	\\x1930d118fece965153bb17f770f119dad51953d2aa7b0f274535eaf52c76b05e5415b44c666583f4c7ae080a9cf3ade4	0
1781900000000	add-share-stats	2026-01-01 00:00:00+00	t	\\x127e20df0d2bb20aacf0f110d011914e22f5f1dd9aeb64c702e9f16661fa08a7e8cb71e2a8419eaabcdd9b2ea06e3cdc	0
1782000000000	add-request-kind	2026-01-01 00:00:00+00	t	\\xb54b99e0affc751c1009fb90537c0d85e12659d1ee30d4915e410c55e6ee2547a5822b88c0084d0f10e0f8c657e56456	0
1782100000000	add-library-metadata-language	2026-01-01 00:00:00+00	t	\\x6bc6fb6604bdfe91a6a4be73fb3b97f15120df16bf2d99cfac991b28baad0b6338fe7f63423bacc064c6d336b9d05018	0
1782200000000	add-translated-subtitle-provider-type	2026-01-01 00:00:00+00	t	\\x6048f8c69ca527241d153799e9b905aa7cb4c85ee2ebb887a89a2aa7cc52bdb31dbbd0eaa9008a57bc65fa6ad8cc2d38	0
1782300000000	create-translation-providers	2026-01-01 00:00:00+00	t	\\x82b1dd0ba36c428fca91ae010d9ee38a976d8defcfb68ffe9d1eccc208b4833c24f3e0c654dd5cfa9f2915658f60da2e	0
1782400000000	add-subtitle-translation-provider-name	2026-01-01 00:00:00+00	t	\\xa68af619967c667a30dbc3f04420c41e6ca7021601340f541224919636bbba610d4705c1225c35bdb33b76e05819aef7	0
1782500000000	add-season-overview-airdate	2026-01-01 00:00:00+00	t	\\xd96e214183672bf678e43af7f54762acf7362596fbe3ebe1d825d21110a986729984970f17ada847b6961e24d83a7be5	0
1782600000000	add-blocklist-source-title-unique-index	2026-01-01 00:00:00+00	t	\\xb1aa55e0d152b12010a6700f0bb0b4ad9a974149e365332c23152c82ca0311e8d459d330735f0038e11d4a477b1b04a9	0
1782700000000	drop-blocklist-indexer-fk	2026-01-01 00:00:00+00	t	\\x656a808306fb234221c68bea61d49f9096448206260d6335e35180ae247d7c18dd6cee15f780d6b6945063c9a1ef44aa	0
1782800000000	create-plugin-tables	2026-01-01 00:00:00+00	t	\\xc0d26f64cb626f22d881c4c9fc393049756546ad3f34455ab569d0822555084b4027d56d68949b0b62abf1de686e8623	0
1782900000000	add-plugin-package-status-reason	2026-01-01 00:00:00+00	t	\\x91922e4b2d707160e7d76ec59c3a0eca05908a71bcef0f678fc976b439c70065f139c1deba7aaa73d95bb791a812fb77	0
1783000000000	align-timestamp-columns-to-timestamptz	2026-01-01 00:00:00+00	t	\\x587b07a0496a148d73b315f51d40b972b5c7fefa4a2aa980c4e12e98307e7f62c0daff1e0efabecbf7c3a91035d15926	0
1783100000000	seed-official-plugin-source	2026-01-01 00:00:00+00	t	\\x10acfe72262364b8bf125c157cfe3eee63c6eb8e6b2de7a83e4476d409ce571f66ecc36864899269041fdafe933be882	0
1783200000000	drop-cleanup-profiles	2026-01-01 00:00:00+00	t	\\x2793174f9c096d03ea00d138ccb2c0b028f1b0294cda02a126ba0bfceaf575bea1846f9a9b29e04ff01ad61f2ee87bc2	0
1783300000000	drop-acquisition-tables	2026-01-01 00:00:00+00	t	\\x3d80b5334adde1972e9ac23612ca0f023be6f37b22b8f960f1ac7b7ae2e703b1f12bc4225b4d0274a4811edee4e3e299	0
1783400000000	index-playback-state-unique-per-target	2026-01-01 00:00:00+00	t	\\xe1aaee9013816a99e1c34ab58f8228247c3fa51d89138b6a25995887be120e8f192b8ad6288964e8970fb51e621bbe61	0
1783500000000	add-plugin-package-enabled	2026-01-01 00:00:00+00	t	\\x62a643da0f1644b9dcd6c4833de616347742148b87f74ace6f8b89d49217cca02eecbf208ae382794ed7ae5fb71baaa6	0
1783600000000	drop-plugin-registration-enabled	2026-01-01 00:00:00+00	t	\\xb0fd6493e622cfa44b602a9c931b006dd5a683769a390bb4c47f1bc0c959efb0a7e3900447532994ab0d69fed8d7c8ad	0
1783700000000	index-episodes-season-id	2026-01-01 00:00:00+00	t	\\xc0f8efa2ee8437a819832431c0106f648450deec583d681b34c40ea36441f7c281f80114140456f8c72d2c6fb18c2a5b	0
1783800000000	add-plugin-registration-child-uid	2026-01-01 00:00:00+00	t	\\x4424641eeae5fed64d1f8805b6c8c944ad93a72d948850fd785057925f4be5621823b10a5300af8353885bfa722b5427	0
1783900000000	normalize-notification-endpoint-key	2026-01-01 00:00:00+00	t	\\x01800f64c2b3e0dd7c07a8bf0f110dae521abc8a85c88a83da228d5ed2e43c7a58af3dc36153731c7c1ace968c084cc9	0
1784000000000	drop-delay-profiles	2026-01-01 00:00:00+00	t	\\xf8a57c4a01d26b8a90ec9f62d0a2ddbf0171a8ce6509654a713086f1246c48a06375a6ba6fad187ec8798a9fc7c484a3	0
1784100000000	align-foreign-key-names	2026-01-01 00:00:00+00	t	\\xe7c653aa50fbab7372a9b5f6eded12cb99b47c3b65857b99e9781a42d7e3e9c0e0eda6a7c3a0180f59fc5739a700bad4	0
1784200000000	auto-approval-criteria	2026-01-01 00:00:00+00	t	\\xd99d8c34adfa2edf0cdd3d84c8fc8f2e20a5eaeb16241a8d99fde11f1472f099b400f1c8f8f8f2adce241390517f47a4	0
1784300000000	add-hide-spoilers	2026-01-01 00:00:00+00	t	\\x9807eaf8b418f8a63d90a25037ff8fefef683c28c15b3eb9cdabeeb7e71c51485d192372dde9cf8da3d5cbe87889be00	0
1784400000000	add-remote-control-permissions	2026-01-01 00:00:00+00	t	\\x73a32a9a858c0bef8796dee9b536cd63983d341f991ebe1e6a5b761392ab7798553bc9e267744c6ec50f7eaf6d1fe26a	0
1784500000000	add-remote-control-grants	2026-01-01 00:00:00+00	t	\\xb1d6091b6f6bd1f288f626f3091f9ddf80d5bdb4854ba4c1a303fe10d9b5eadbb1e22aab2652666c9e9886b9f6b576e9	0
1784600000000	custom-format-specs-and-min-score	2026-01-01 00:00:00+00	t	\\x9a336a36f31b6817779f4c49be37e2f0dbf7c16cacbef7a296587017f0b8e3fc71722a39f19571d5d126802a7df591a2	0
1784700000000	index-subtitle-files-media	2026-01-01 00:00:00+00	t	\\xbbe1c65995aadfd9dd8ffca3ffbe113420968665c9fd4bcd2282f8b359b4b32cd101fd12ed05b5cc2b9c2cf44f7db6ee	0
1784800000000	add-subtitle-error-message	2026-01-01 00:00:00+00	t	\\x688a5b51299fc5965f5c5088872c0b064eeda63c9e740ae958f91778eadfe3ffb707ae5c762aa00b408b8f5067924037	0
1784900000000	add-subtitle-sync-failed	2026-01-01 00:00:00+00	t	\\x55d20cb5a84c161fd21c9a56352c96cfad8b1e4a16747b7f64cf6de6ac692c98a7401457e5d6a0288cba8d3a9cf122af	0
1785000000000	quality-definition-min-sizes	2026-01-01 00:00:00+00	t	\\xeb6ed40561434d1db9274281b6f91232e58420e8cece3c3f9c887a07a1ae7b5d10191692b405525987314793e1486047	0
1785100000000	scope-person-ids-by-provider	2026-01-01 00:00:00+00	t	\\xdeb32a4d54730c99824048266efbc5cf1040cf08332fe83abfe628f97ed07cc52e9404d5a11db46f90f1d7728634133d	0
1785200000000	split-roles-manage-permission	2026-01-01 00:00:00+00	t	\\xc645f3b7001bf9c15f8e9fc8b66ddb0a59228eb01794ac031430a51671fc2f502dfb9a372cddae6960deceb81270fb22	0
1785300000000	drop-default-library-flags	2026-01-01 00:00:00+00	t	\\x926d7938378db414060e6bd4a7587c422d7dbb8d55996dbb77f8d4471c4a59414096a85eefdc84195653ba1f9f49adfd	0
1785400000000	livetv-tables	2026-01-01 00:00:00+00	t	\\xd81fe4ae503b4e4292e8fff30092460fc866a4f360d40d23904a60ad125d5659e31bb55cbfdde3175be335715a595886	0
1785500000000	index-livetv-channel-streams-channel	2026-01-01 00:00:00+00	t	\\xcd6c18afd9fc28a9b4310bb757d57db5ddf190d5331943892aaa4b9c92846151b3cd4cc75c4300fa07aa1438a8d3cd2c	0
1785600000000	normalise-livetv-group-names	2026-01-01 00:00:00+00	t	\\xc31b67e63a320ff8410f7cc302979bd237e54a9e72eb41e738c93a33aee95ddcb9684d7336353999925f97d153654bb7	0
1785700000000	add-livetv-adult-guard-error	2026-01-01 00:00:00+00	t	\\xc5d71771935adad0e969b9e923a588c13d5bbb3c92e01f36f42606c5041e8dcf9c8f75db9b0ab226839a190a52e52816	0
1785800000000	fix-livetv-logo-path-route	2026-01-01 00:00:00+00	t	\\x87b35e1b0b4a8871de98b26916d890348bd5dfbbe65bd0637fabef040cdf8d4d6d8eee6e7781dac8281bb2ceb5bc4032	0
1785900000000	add-media-file-scans	2026-01-01 00:00:00+00	t	\\x363d4b78d570b4979521f57f303c1ab086092a61b3e9e973191d1d92c33280d0a74b2997455e631061383078e649da41	0
1786000000000	add-edl-support	2026-01-01 00:00:00+00	t	\\xf502bb59951e6dfdee074722a851692a540d8e5d45828144b777d04b8f0f73b079adeb81cb2c8c518d6393e4d8314c16	0
1786100000000	canonicalize-subtitle-language-codes	2026-01-01 00:00:00+00	t	\\xc28e984667b7ee200dc1f20ff2b2748068b18a7441cad74a93c1e2c5fe1e7e1766ac67c13176230bbd1bbc9c56eab7e2	0
1786200000000	drop-unrenderable-sidecar-subtitles	2026-01-01 00:00:00+00	t	\\x702474a3b710f21ae49c4e5ce4297bc71705a502c542b8d5d4bc351937a2a96dc6ea76fdb715bf846985ba1d10ee345d	0
1786300000000	create-playback-qoe	2026-01-01 00:00:00+00	t	\\xe5e4e8991f47690862b8d28d5e8b63acb95506c8288faf97d8d6d97e2cedb18dffe15ce35e842e97064976fa12d03cea	0
1786400000000	pg trgm	2026-01-01 00:00:00+00	t	\\x5364f2aab2a907ef12aa2aeb5b6a24d04f8839b7f5835c35ba52f29c0568cbb0c8435ce0f60e1f3b1546e43b8abe8360	0
1786500000000	updated at trigger	2026-01-01 00:00:00+00	t	\\xa08d5738eee946976096dae99719b149c27748ba8250460ae2bcf7be938e642c694351c72dac35289c99f018ddb18cca	0
1786600000000	media search vector	2026-01-01 00:00:00+00	t	\\xcfeecff428f67c3a7cb5a9ce90f642cb107559291054384f27b83488ebe418331f87814468e5c0692ac0d5c4b2d0970e	0
1786700000000	iso ms function	2026-01-01 00:00:00+00	t	\\x941e1bc6e1fedf78b23d8612b99132fdd779c547bd2b625b5d113fcb821c19d2e6670f4d8d4813783cb3aade40dd8d98	0
1786830000000	persons search vector	2026-01-01 00:00:00+00	t	\\x5193d58a2af78a4d8fe0a7002ed1972d27e4d9387c88624b31612aa4e25abff5cd185024ad663a244b1a7cc0dc04a773	0
1786900000000	plugins-wasm-host	2026-01-01 00:00:00+00	t	\\x7d91aa54274314dac952692f4a1fd58bda4230dc5731e69d7931a734ee896f9e53eeee367dfeaa00e9b8c1ada16ea4f7	0
1787100000000	livetv clear xtream guide urls	2026-01-01 00:00:00+00	t	\\x5a36fd84eb4d4ae7c1d06968dfbed790b0d10f30c2d678d6fb1269d478fe499edf757e4788e4ab9a99f987b731e1b8a3	0
1787200000000	media servers normalise url events	2026-01-01 00:00:00+00	t	\\x9e0d54fd35a784876bdc6f42733fa342451034320e0858c161176d29162f6881bd406bfb7e388a1aeb9478bf75e11f05	0
1787300000000	index-foreign-keys	2026-01-01 00:00:00+00	t	\\x64c5d78776c1a2e11bcf46c029df9ac16794413b55e4248da5d1e8e431b694a53b87ee980be57b3c1df6acb266085331	0
1787400000000	media-cleanup	2026-01-01 00:00:00+00	t	\\xece72fa7349805895c0869df4f53128c1229692ad422f35cd7b058290c449fc8d0102264579282d0ce833e7c24ecf740	0
1787500000000	cleanup-season-episode	2026-01-01 00:00:00+00	t	\\xd37f435e256e0a48705f32cb8250a8d6f43acaa5f6e4a06c074985af8c36ea703b668a5a6297002f9b6faadcd6c8b15c	0
1787600000000	playback-history	2026-01-01 00:00:00+00	t	\\x8937f5cc4e28636882ccc2ed91517abfcc65eee6d954501c15e0e83d50eaedd7befae639b8ad1bf7ceda5bbb053cb975	0
1787700000000	cleanup-reminders	2026-01-01 00:00:00+00	t	\\xd2740129ef7b5733209232400958529690f7b7215d4f90d328eff855dd64973e20030a8047f249939dd6903c90149bb8	0
\.


--
-- Data for Name: app_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_settings (id, "createdAt", "updatedAt", key, value) FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	parity_flag	on
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	parity_json	{"a":1}
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	parity_null	\N
\.


--
-- Data for Name: auto_approval_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auto_approval_rules (id, "createdAt", "updatedAt", name, enabled, criteria) FROM stdin;
\.


--
-- Data for Name: cleanup_candidates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cleanup_candidates ("mediaId", "ruleId", "flaggedAt", "deleteAt", id, "seasonId", "episodeId", "lastReminderDays") FROM stdin;
\.


--
-- Data for Name: cleanup_exclusions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cleanup_exclusions ("mediaId", "userId", "createdAt", id, "seasonId", "episodeId") FROM stdin;
\.


--
-- Data for Name: cleanup_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cleanup_rules (id, "createdAt", "updatedAt", name, enabled, criteria, action, "graceDays", level, "deleteSeriesWhenEmpty", "reminderDays") FROM stdin;
\.


--
-- Data for Name: commands; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.commands (id, "createdAt", "updatedAt", name, status, "startedOn", "endedOn", trigger, body) FROM stdin;
\.


--
-- Data for Name: content_recommendations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.content_recommendations (id, "createdAt", "updatedAt", "senderId", "recipientId", "mediaId", "seasonId", "episodeId", message, "dismissedAt") FROM stdin;
\.


--
-- Data for Name: custom_formats; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.custom_formats (id, "createdAt", "updatedAt", name, score, specs) FROM stdin;
\.


--
-- Data for Name: episode_markers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.episode_markers (id, "createdAt", "updatedAt", type, "startSeconds", "endSeconds", confidence, manual, "episodeId") FROM stdin;
\.


--
-- Data for Name: episodes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.episodes (id, "createdAt", "updatedAt", "episodeNumber", "endEpisodeNumber", title, overview, "airDate", runtime, monitored, "hasFile", "stillUrl", "markersScannedAt", "searchVector", "seasonId") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	1
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	1
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	2
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	2
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	3
6	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	3
7	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	4
8	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	4
9	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	5
10	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	5
11	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	\N	Episode 1	\N	\N	\N	t	t	\N	\N	\N	6
12	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	\N	Episode 2	\N	\N	\N	t	t	\N	\N	\N	6
\.


--
-- Data for Name: language_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Toutes les langues (défaut)	[]	[]
\.


--
-- Data for Name: libraries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", "preferredProvider", "defaultQualityProfileId", "defaultLanguageProfileId", path, label, "metadataLanguage", "metadataRegion") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Movies	film	#3b82f6	["movie"]	\N	\N	\N	/tmp/fliks-parity/media/movies	\N	\N	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Series	tv	#10b981	["series"]	\N	\N	\N	/tmp/fliks-parity/media/series	\N	\N	\N
\.


--
-- Data for Name: library_user_access; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.library_user_access (id, "createdAt", "updatedAt", "libraryId", "userId") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	2
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	2
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	3
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	4
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	4
6	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	5
7	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	5
\.


--
-- Data for Name: likes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.likes (id, "createdAt", "updatedAt", "userId", "mediaId", "seasonId", "episodeId") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	1	\N	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	18	\N	\N
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	4	2	\N	\N
\.


--
-- Data for Name: livetv_channel_streams; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_channel_streams (id, "createdAt", "updatedAt", "externalId", url, priority, "qualityLabel", "providerName", "userAgent", referer, "lastSeenAt", "probedVideoCodec", "probedAudioCodec", "probedContainer", "lastOkAt", "lastError", "channelId", "sourceId") FROM stdin;
\.


--
-- Data for Name: livetv_channels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_channels (id, "createdAt", "updatedAt", name, number, "logoPath", "groupName", enabled, "sortIndex", "guideChannelId", "guideMatchKind", "guideShiftMinutes", "lastPlayedAt", "lastErrorAt", "consecutiveFailures", "groupNameSource") FROM stdin;
\.


--
-- Data for Name: livetv_group_access; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_group_access (id, "createdAt", "updatedAt", "groupName", "userId") FROM stdin;
\.


--
-- Data for Name: livetv_guide_channels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_guide_channels (id, "createdAt", "updatedAt", "channelId", "displayNames", "iconUrl", "guideSourceId") FROM stdin;
\.


--
-- Data for Name: livetv_guide_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_guide_sources (id, "createdAt", "updatedAt", name, kind, url, "refreshIntervalHours", "timezoneOffsetMinutes", language, priority, enabled, "lastSyncAt", "lastSyncStatus", "lastSyncError", "programCount", etag, "lastModified", "sourceId") FROM stdin;
\.


--
-- Data for Name: livetv_programs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_programs (id, "createdAt", "updatedAt", "guideChannelId", "startsAt", "endsAt", title, subtitle, description, categories, "iconUrl", "seasonNumber", "episodeNumber", "seriesId", "isNew", "isLive", rating, year, "guideSourceId") FROM stdin;
\.


--
-- Data for Name: livetv_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_sources (id, "createdAt", "updatedAt", name, kind, url, username, password, "userAgent", referer, "maxStreams", "maxStreamsIsManual", "refreshIntervalHours", "includeGroupsPattern", "excludeGroupsPattern", "expiresAt", "accountStatus", "guideUrls", "playlistEtag", "playlistLastModified", enabled, priority, "lastSyncAt", "lastSyncStatus", "lastSyncError", "channelCount", "lastAdultGuardError") FROM stdin;
\.


--
-- Data for Name: livetv_user_channel_prefs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.livetv_user_channel_prefs (id, "createdAt", "updatedAt", favorite, hidden, "lastPlayedAt", "userId", "channelId") FROM stdin;
\.


--
-- Data for Name: media; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media (id, "createdAt", "updatedAt", title, "originalTitle", year, type, "tmdbId", "imdbId", "tvdbId", overview, status, monitored, "preferredProvider", "folderName", "posterUrl", "metadataRefreshedAt", "fanartUrl", rating, genres, runtime, "releaseDate", "inCinemas", "digitalRelease", "physicalRelease", "minimumAvailability", "searchVector", "libraryId", "qualityProfileId", "languageProfileId", "addedById", "alternativeTitles", "tmdbCollectionId", "tmdbCollectionName", "additionalFanartUrls", "logoUrl") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 01	\N	2020	movie	1001	\N	\N	Synthetic movie 1	released	t	\N	Parity Movie 01 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'01':3A '1':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 02	\N	2020	movie	1002	\N	\N	Synthetic movie 2	released	t	\N	Parity Movie 02 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'02':3A '2':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 03	\N	2020	movie	1003	\N	\N	Synthetic movie 3	released	t	\N	Parity Movie 03 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'03':3A '3':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 04	\N	2020	movie	1004	\N	\N	Synthetic movie 4	released	t	\N	Parity Movie 04 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'04':3A '4':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 05	\N	2020	movie	1005	\N	\N	Synthetic movie 5	released	t	\N	Parity Movie 05 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'05':3A '5':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
6	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 06	\N	2020	movie	1006	\N	\N	Synthetic movie 6	released	t	\N	Parity Movie 06 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'06':3A '6':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
7	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 07	\N	2020	movie	1007	\N	\N	Synthetic movie 7	released	t	\N	Parity Movie 07 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'07':3A '7':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
8	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 08	\N	2020	movie	1008	\N	\N	Synthetic movie 8	released	t	\N	Parity Movie 08 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'08':3A '8':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
9	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 09	\N	2020	movie	1009	\N	\N	Synthetic movie 9	released	t	\N	Parity Movie 09 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'09':3A '9':6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
10	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 10	\N	2020	movie	1010	\N	\N	Synthetic movie 10	released	t	\N	Parity Movie 10 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'10':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
11	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 11	\N	2020	movie	1011	\N	\N	Synthetic movie 11	released	t	\N	Parity Movie 11 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'11':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
12	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 12	\N	2020	movie	1012	\N	\N	Synthetic movie 12	released	t	\N	Parity Movie 12 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'12':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
13	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 13	\N	2020	movie	1013	\N	\N	Synthetic movie 13	released	t	\N	Parity Movie 13 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'13':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
14	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 14	\N	2020	movie	1014	\N	\N	Synthetic movie 14	released	t	\N	Parity Movie 14 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'14':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
15	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 15	\N	2020	movie	1015	\N	\N	Synthetic movie 15	released	t	\N	Parity Movie 15 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'15':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
16	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 16	\N	2020	movie	1016	\N	\N	Synthetic movie 16	released	t	\N	Parity Movie 16 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'16':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
17	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 17	\N	2020	movie	1017	\N	\N	Synthetic movie 17	released	t	\N	Parity Movie 17 (2020)	\N	\N	\N	7.5	["Drama"]	90	2020-01-01	\N	\N	\N	released	'17':3A,6C 'mov':2A,5C 'parity':1A 'synthetic':4C	1	\N	\N	\N	[]	\N	\N	{}	\N
18	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Series A	\N	2021	series	2000	\N	\N	Synthetic series A	continuing	t	\N	Parity Series A	\N	\N	\N	8	["Drama"]	30	\N	\N	\N	\N	released	'a':3A,6C 'parity':1A 'ser':2A,5C 'synthetic':4C	2	\N	\N	\N	[]	\N	\N	{}	\N
19	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Series B	\N	2021	series	2001	\N	\N	Synthetic series B	continuing	t	\N	Parity Series B	\N	\N	\N	8	["Drama"]	30	\N	\N	\N	\N	released	'b':3A,6C 'parity':1A 'ser':2A,5C 'synthetic':4C	2	\N	\N	\N	[]	\N	\N	{}	\N
20	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Series C	\N	2021	series	2002	\N	\N	Synthetic series C	continuing	t	\N	Parity Series C	\N	\N	\N	8	["Drama"]	30	\N	\N	\N	\N	released	'parity':1A 'ser':2A,4C 'synthetic':3C	2	\N	\N	\N	[]	\N	\N	{}	\N
\.


--
-- Data for Name: media_cast; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_cast (id, "createdAt", "updatedAt", "character", "order", "mediaId", "personId") FROM stdin;
\.


--
-- Data for Name: media_crew; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_crew (id, "createdAt", "updatedAt", job, department, "mediaId", "personId") FROM stdin;
\.


--
-- Data for Name: media_file_scans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_file_scans (id, "createdAt", "updatedAt", "mediaFileId", size, "mtimeMs", scan) FROM stdin;
\.


--
-- Data for Name: media_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_files (id, "createdAt", "updatedAt", "relativePath", size, quality, language, "streamInfo", "mediaId", "episodeId", "osdbHash", "osdbBytesize") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 01 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	1	\N	\N	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 02 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	2	\N	\N	\N
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 03 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	3	\N	\N	\N
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 04 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	4	\N	\N	\N
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 05 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	5	\N	\N	\N
6	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 06 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	6	\N	\N	\N
7	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 07 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	7	\N	\N	\N
8	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 08 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	8	\N	\N	\N
9	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 09 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	9	\N	\N	\N
10	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 10 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	10	\N	\N	\N
11	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 11 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	11	\N	\N	\N
12	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 12 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	12	\N	\N	\N
13	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 13 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	13	\N	\N	\N
14	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 14 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	14	\N	\N	\N
15	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 15 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	15	\N	\N	\N
16	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 16 (2020).mp4	74465	WEBDL-1080p	en	{"audio": [{"codec": "aac", "bitRate": 64628, "profile": "LC", "channels": 1, "language": "eng", "isDefault": true, "endSeconds": 3, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "bitRate": 124082, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "formatBitRate": 198573, "durationSeconds": 3, "formatStartSeconds": 0}	16	\N	\N	\N
17	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Movie 17 (2020).mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	17	\N	\N	\N
18	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series A - S01E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	18	1	\N	\N
19	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series A - S01E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	18	2	\N	\N
20	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series A - S02E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	18	3	\N	\N
21	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series A - S02E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	18	4	\N	\N
22	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series B - S01E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	19	5	\N	\N
23	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series B - S01E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	19	6	\N	\N
24	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series B - S02E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	19	7	\N	\N
25	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series B - S02E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	19	8	\N	\N
26	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series C - S01E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	20	9	\N	\N
27	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 01/Parity Series C - S01E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	20	10	\N	\N
28	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series C - S02E01.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	20	11	\N	\N
29	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Season 02/Parity Series C - S02E02.mkv	73237	WEBDL-1080p	en	{"audio": [{"codec": "aac", "profile": "LC", "channels": 1, "language": "eng", "isDefault": false, "endSeconds": 3.021, "sampleRate": 48000, "streamIndex": 1, "channelLayout": "mono", "startTimeSeconds": 0}], "video": [{"codec": "h264", "level": 10, "width": 160, "height": 90, "profile": "High", "bitDepth": 8, "frameRate": "24", "hdr10Plus": false, "colorRange": "tv", "endSeconds": 3, "dvBlPresent": false, "dvElPresent": false, "pixelFormat": "yuv420p", "streamIndex": 0, "avgFrameRate": "24/1", "dvRpuPresent": false, "reorderFrames": 2, "startTimeSeconds": 0, "firstFrameSeconds": 0, "displayAspectRatio": "16:9"}], "chapters": [], "subtitles": [], "formatName": "matroska,webm", "formatBitRate": 193941, "durationSeconds": 3.021, "formatStartSeconds": 0}	20	12	\N	\N
\.


--
-- Data for Name: media_metadata; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_metadata (id, "createdAt", "updatedAt", budget, revenue, tagline, popularity, "voteCount", "originalLanguage", "productionCountries", "productionCompanies", videos, keywords, "mediaId") FROM stdin;
\.


--
-- Data for Name: media_servers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_servers (id, "createdAt", "updatedAt", name, type, url, "apiKey", events, enabled) FROM stdin;
\.


--
-- Data for Name: notification_connections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_connections (id, "createdAt", "updatedAt", name, type, settings, events, enabled) FROM stdin;
\.


--
-- Data for Name: pairing_requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pairing_requests (id, "createdAt", "updatedAt", "publicId", "userId", "deviceId", "deviceName", status, "approvedByUserId", "accessToken", "expiresAt", "systemName") FROM stdin;
\.


--
-- Data for Name: persons; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.persons (id, "createdAt", "updatedAt", "tmdbId", name, "avatarUrl", biography, birthday, deathday, "placeOfBirth", "knownForDepartment", departments, "metadataRefreshedAt", "searchVector", provider) FROM stdin;
\.


--
-- Data for Name: playback_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playback_history (id, "userId", "mediaId", "episodeId", "playedAt") FROM stdin;
\.


--
-- Data for Name: playback_qoe_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playback_qoe_events (id, "sessionId", at, type, data) FROM stdin;
\.


--
-- Data for Name: playback_qoe_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playback_qoe_sessions ("sessionId", "playbackId", "userId", "mediaFileId", "mediaTitle", "startedAt", "lastSeenAt", "endedAt", "deviceLabel", "systemName", "appVersion", engine, cmcd, "cmcdClaimed", "playMethod", quality, "transcodeReasons", "videoCodec", width, height, "decoderName", "hwDecoder", "watchedMs", "stallCount", "stallMs", "droppedFrames", "decodedFrames", "avgBandwidthBps", "minBandwidthBps", "avgVariantBitrate", "recoveryReloads", "errorCount", "medianTranscodeSpeed", "stallBufferAheadS", "stallBandwidthBps", "cmcdThroughputBps", "unrecoveredError", "sampleCount", "stallCauseMs", "stallReasonMs", pipeline, verdict, confidence, reasons, "playbackVerdict", "playbackConfidence") FROM stdin;
\.


--
-- Data for Name: playback_states; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playback_states (id, "createdAt", "updatedAt", "positionSeconds", "durationSeconds", completed, "hiddenFromContinueWatching", "lastPlayedAt", "playedAt", "userId", "mediaId", "mediaFileId", "episodeId") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1200	3600	f	f	2026-01-02 00:00:00+00	\N	2	1	1	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	3500	3600	t	f	2026-01-03 00:00:00+00	2026-01-03 00:00:00+00	2	2	2	\N
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	600	1800	f	f	2026-01-04 00:00:00+00	\N	2	18	18	1
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	300	3600	f	f	2026-01-02 00:00:00+00	\N	3	1	1	\N
\.


--
-- Data for Name: playlist_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playlist_items (id, "createdAt", "updatedAt", "playlistId", "mediaId", "episodeId", "position", "addedById") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	1	\N	0	2
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	2	\N	1	2
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	3	\N	2	2
\.


--
-- Data for Name: playlist_saves; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playlist_saves (id, "createdAt", "updatedAt", "userId", "playlistId") FROM stdin;
\.


--
-- Data for Name: playlist_shares; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playlist_shares (id, "createdAt", "updatedAt", "playlistId", "userId", role) FROM stdin;
\.


--
-- Data for Name: playlists; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.playlists (id, "createdAt", "updatedAt", name, "ownerId", "autoRemoveWatched", "autoDownload", "coverImageUrl", "autoPlay", visibility) FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Parity Playlist	2	f	f	\N	f	private
\.


--
-- Data for Name: plugin_packages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plugin_packages (id, "createdAt", "updatedAt", "pluginId", version, archive, origin, signature, "verifiedByKeyId", manifest, status, "statusReason", enabled, "networkInternal", "cwasmSha256", "cwasmEngine") FROM stdin;
\.


--
-- Data for Name: plugin_registrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plugin_registrations (id, "createdAt", "updatedAt", "pluginId", "ingestRoots", scopes, manifest) FROM stdin;
\.


--
-- Data for Name: plugin_scheduled_calls; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plugin_scheduled_calls ("pluginId", key, "runAt", payload, attempt, version) FROM stdin;
\.


--
-- Data for Name: plugin_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plugin_sources (id, "createdAt", "updatedAt", url, enabled, "publicKey", "lastRefreshedAt", "lastRefreshError", "cachedCatalog") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	https://fliks-app.github.io/fliks-plugin-catalog/catalog.json	t	\N	\N	\N	\N
\.


--
-- Data for Name: quality_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quality_definitions (id, "createdAt", "updatedAt", "qualityId", title, "minSize", "preferredSize", "maxSize") FROM stdin;
\.


--
-- Data for Name: quality_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items, "upgradeAllowed", "resolutionUpgradeOnly", "minCustomFormatScore") FROM stdin;
\.


--
-- Data for Name: recommendation_dismissals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recommendation_dismissals (id, "createdAt", "updatedAt", "userId", "mediaId") FROM stdin;
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.refresh_tokens (id, "createdAt", "updatedAt", "userId", "tokenHash", "expiresAt", "revokedAt", "userAgent", "lastUsedAt") FROM stdin;
\.


--
-- Data for Name: remote_control_grants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.remote_control_grants (id, "createdAt", "updatedAt", code, "deviceId", "ownerUserId", "granteeUserId", "deviceName", "codeExpiresAt") FROM stdin;
\.


--
-- Data for Name: request_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.request_comments (id, "createdAt", "updatedAt", message, "requestId", "userId") FROM stdin;
\.


--
-- Data for Name: requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.requests (id, "createdAt", "updatedAt", "mediaType", "tmdbId", title, status, "declinedReason", seasons, "userId", "approvedById", "qualityProfileId", "languageProfileId", "libraryId", "mediaId", "posterUrl", "fanartUrl", kind) FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	movie	9001	Requested Movie	pending	\N	\N	2	\N	\N	\N	1	\N	\N	\N	add
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	series	9002	Requested Series	approved	\N	\N	4	\N	\N	\N	2	\N	\N	\N	add
\.


--
-- Data for Name: role_default_libraries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.role_default_libraries ("roleId", "libraryId") FROM stdin;
2	1
2	2
\.


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Admin	["media.read","media.create","media.edit","media.delete","media.grab","livetv.read","requests.create","requests.manage","subtitles.manage","settings.access","users.manage","roles.manage"]	f
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	User	["media.read","livetv.read","requests.create"]	t
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Readonly	["media.read","livetv.read"]	f
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	Manager	["media.read","users.manage"]	f
\.


--
-- Data for Name: seasons; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.seasons (id, "createdAt", "updatedAt", "seasonNumber", monitored, "preferredProvider", "mediaId", "posterUrl", overview, "airDate") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	t	\N	18	\N	\N	\N
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	t	\N	18	\N	\N	\N
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	t	\N	19	\N	\N	\N
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	t	\N	19	\N	\N	\N
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	1	t	\N	20	\N	\N	\N
6	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	2	t	\N	20	\N	\N	\N
\.


--
-- Data for Name: subtitle_blacklist; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subtitle_blacklist (id, "createdAt", "updatedAt", "providerType", "providerFileId", language, "sourceTitle", reason, "mediaId") FROM stdin;
\.


--
-- Data for Name: subtitle_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subtitle_files (id, "createdAt", "updatedAt", language, forced, "hearingImpaired", "providerType", "providerFileId", "filePath", status, "streamIndex", codec, score, synced, "syncOffset", locked, tags, "mediaId", "episodeId", "mediaFileId", "hashMatched", "sourceStreamIndex", "translationProviderId", "translationEngine", "translationModel", "translationProviderName", "errorMessage", "syncFailed") FROM stdin;
\.


--
-- Data for Name: subtitle_provider_stats; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subtitle_provider_stats (id, "queryDate", "queryType", "responseTimeMs", "resultCount", "errorMessage", "providerId") FROM stdin;
\.


--
-- Data for Name: subtitle_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subtitle_providers (id, "createdAt", "updatedAt", name, type, enabled, settings, priority) FROM stdin;
\.


--
-- Data for Name: translation_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.translation_providers (id, "createdAt", "updatedAt", name, engine, enabled, "isDefault", settings) FROM stdin;
\.


--
-- Data for Name: user_follows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_follows (id, "createdAt", "updatedAt", "followerId", "followingId", status) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "mediaServerType", "mediaServerId", avatar, "lastLogin", "isAdmin", enabled, "requirePasswordChange", "movieQuotaLimit", "seriesQuotaLimit", "quotaPeriodDays", "libraryOrder", "hiddenLibraryIds", "profileVisibility", "shareTastes", "shareRecommendations", "shareWatchHistory", "shareLikes", "shareDisabled", "shareStats", "hideSpoilers", "spoilerHideStills", "spoilerHideOverviews", "spoilerHideTitles", "edlEnabled", "edlAutoSkipCommercials") FROM stdin;
1	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	admin	admin@parity.test	$2b$10$mrdWC15ycA2Rj3R4TkCrmOjREitArik5RyYlTj321tduIJEg6L3j.	\N	local	\N	\N	\N	t	t	f	0	0	7	[]	[]	private	f	f	f	f	f	f	f	t	t	t	t	t
2	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	user	user@parity.test	$2b$10$eruz5MPbynE0zGJakNz.Megq1Chq0fpuEs3fxZjRiqKstt50S3WjK	2	local	\N	\N	\N	f	t	f	0	0	7	[]	[]	private	f	f	f	f	f	f	f	t	t	t	t	t
3	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	readonly	readonly@parity.test	$2b$10$.yaNcwA9gwTu4YyRScgESeSOn1XxH53H8H41ix4KFH0IQg1Lr5Of.	3	local	\N	\N	\N	f	t	f	0	0	7	[]	[]	private	f	f	f	f	f	f	f	t	t	t	t	t
4	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	other	other@parity.test	$2b$10$NELnurd6YNZvN22qu743I.4Hbhm3lp8C2E2fPV8X2M2NII1434f2y	2	local	\N	/api/users/4/avatar?v=1767225600000	\N	f	t	f	0	0	7	[]	[]	private	f	f	f	f	f	f	f	t	t	t	t	t
5	2026-01-01 00:00:00+00	2026-01-01 00:00:00+00	manager	manager@parity.test	$2b$10$Ut70hjOYdk4JkkYE2.atA.RDi56Nkj1YW6RUYwjPu3bafFozSqCX6	4	local	\N	\N	\N	f	t	f	0	0	7	[]	[]	private	f	f	f	f	f	f	f	t	t	t	t	t
\.


--
-- Name: app_settings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.app_settings_id_seq', 3, true);


--
-- Name: auto_approval_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.auto_approval_rules_id_seq', 1, false);


--
-- Name: cleanup_candidates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cleanup_candidates_id_seq', 1, false);


--
-- Name: cleanup_exclusions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cleanup_exclusions_id_seq', 1, false);


--
-- Name: cleanup_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cleanup_rules_id_seq', 1, false);


--
-- Name: commands_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.commands_id_seq', 1, false);


--
-- Name: content_recommendations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.content_recommendations_id_seq', 1, false);


--
-- Name: custom_formats_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.custom_formats_id_seq', 1, false);


--
-- Name: episode_markers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.episode_markers_id_seq', 1, false);


--
-- Name: episodes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.episodes_id_seq', 12, true);


--
-- Name: language_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.language_profiles_id_seq', 1, true);


--
-- Name: libraries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.libraries_id_seq', 2, true);


--
-- Name: library_user_access_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.library_user_access_id_seq', 7, true);


--
-- Name: likes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.likes_id_seq', 3, true);


--
-- Name: livetv_channel_streams_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_channel_streams_id_seq', 1, false);


--
-- Name: livetv_channels_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_channels_id_seq', 1, false);


--
-- Name: livetv_group_access_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_group_access_id_seq', 1, false);


--
-- Name: livetv_guide_channels_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_guide_channels_id_seq', 1, false);


--
-- Name: livetv_guide_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_guide_sources_id_seq', 1, false);


--
-- Name: livetv_programs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_programs_id_seq', 1, false);


--
-- Name: livetv_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_sources_id_seq', 1, false);


--
-- Name: livetv_user_channel_prefs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.livetv_user_channel_prefs_id_seq', 1, false);


--
-- Name: media_cast_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_cast_id_seq', 1, false);


--
-- Name: media_crew_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_crew_id_seq', 1, false);


--
-- Name: media_file_scans_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_file_scans_id_seq', 1, false);


--
-- Name: media_files_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_files_id_seq', 29, true);


--
-- Name: media_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_id_seq', 20, true);


--
-- Name: media_metadata_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_metadata_id_seq', 1, false);


--
-- Name: media_servers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_servers_id_seq', 1, false);


--
-- Name: notification_connections_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.notification_connections_id_seq', 1, false);


--
-- Name: pairing_requests_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pairing_requests_id_seq', 1, false);


--
-- Name: persons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.persons_id_seq', 1, false);


--
-- Name: playback_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playback_history_id_seq', 1, false);


--
-- Name: playback_qoe_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playback_qoe_events_id_seq', 1, false);


--
-- Name: playback_states_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playback_states_id_seq', 4, true);


--
-- Name: playlist_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playlist_items_id_seq', 3, true);


--
-- Name: playlist_saves_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playlist_saves_id_seq', 1, false);


--
-- Name: playlist_shares_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playlist_shares_id_seq', 1, false);


--
-- Name: playlists_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.playlists_id_seq', 1, true);


--
-- Name: plugin_packages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.plugin_packages_id_seq', 1, false);


--
-- Name: plugin_registrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.plugin_registrations_id_seq', 1, false);


--
-- Name: plugin_scheduled_calls_version_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.plugin_scheduled_calls_version_seq', 1, false);


--
-- Name: plugin_sources_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.plugin_sources_id_seq', 1, true);


--
-- Name: quality_definitions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quality_definitions_id_seq', 1, false);


--
-- Name: quality_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quality_profiles_id_seq', 1, false);


--
-- Name: recommendation_dismissals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.recommendation_dismissals_id_seq', 1, false);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.refresh_tokens_id_seq', 1, false);


--
-- Name: remote_control_grants_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.remote_control_grants_id_seq', 1, false);


--
-- Name: request_comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.request_comments_id_seq', 1, false);


--
-- Name: requests_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.requests_id_seq', 2, true);


--
-- Name: roles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.roles_id_seq', 4, true);


--
-- Name: seasons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.seasons_id_seq', 6, true);


--
-- Name: subtitle_blacklist_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subtitle_blacklist_id_seq', 1, false);


--
-- Name: subtitle_files_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subtitle_files_id_seq', 1, false);


--
-- Name: subtitle_provider_stats_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subtitle_provider_stats_id_seq', 1, false);


--
-- Name: subtitle_providers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subtitle_providers_id_seq', 1, false);


--
-- Name: translation_providers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.translation_providers_id_seq', 1, false);


--
-- Name: user_follows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.user_follows_id_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 5, true);


--
-- Name: requests PK_0428f484e96f9e6a55955f29b5f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "PK_0428f484e96f9e6a55955f29b5f" PRIMARY KEY (id);


--
-- Name: custom_formats PK_076675654bab65414d7c59160eb; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_formats
    ADD CONSTRAINT "PK_076675654bab65414d7c59160eb" PRIMARY KEY (id);


--
-- Name: subtitle_provider_stats PK_07ed845bbe29f017fbadb2e1e06; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_provider_stats
    ADD CONSTRAINT "PK_07ed845bbe29f017fbadb2e1e06" PRIMARY KEY (id);


--
-- Name: livetv_group_access PK_15800fff943da31cff821faabe6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_group_access
    ADD CONSTRAINT "PK_15800fff943da31cff821faabe6" PRIMARY KEY (id);


--
-- Name: subtitle_files PK_1d4ab28141e13ad42262cab12b3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "PK_1d4ab28141e13ad42262cab12b3" PRIMARY KEY (id);


--
-- Name: livetv_channel_streams PK_23d8433c02f6064c9c196423089; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "PK_23d8433c02f6064c9c196423089" PRIMARY KEY (id);


--
-- Name: livetv_programs PK_270df4c18a60727a2340fbd97a2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_programs
    ADD CONSTRAINT "PK_270df4c18a60727a2340fbd97a2" PRIMARY KEY (id);


--
-- Name: livetv_channels PK_2e6f017729660b63bbc0de27db7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channels
    ADD CONSTRAINT "PK_2e6f017729660b63bbc0de27db7" PRIMARY KEY (id);


--
-- Name: subtitle_blacklist PK_3f978f16e490f314ac14a3b4a6a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_blacklist
    ADD CONSTRAINT "PK_3f978f16e490f314ac14a3b4a6a" PRIMARY KEY (id);


--
-- Name: playback_states PK_40ce4d415c9dcfaf467b7473614; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "PK_40ce4d415c9dcfaf467b7473614" PRIMARY KEY (id);


--
-- Name: media_cast PK_444fff397439c1f5b7918ebc5ec; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "PK_444fff397439c1f5b7918ebc5ec" PRIMARY KEY (id);


--
-- Name: episode_markers PK_47780a1be9b93671c0286aedc06; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT "PK_47780a1be9b93671c0286aedc06" PRIMARY KEY (id);


--
-- Name: app_settings PK_4800b266ba790931744b3e53a74; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT "PK_4800b266ba790931744b3e53a74" PRIMARY KEY (id);


--
-- Name: libraries PK_505fedfcad00a09b3734b4223de; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "PK_505fedfcad00a09b3734b4223de" PRIMARY KEY (id);


--
-- Name: livetv_user_channel_prefs PK_5e7987b481758c46a49f0301a8d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "PK_5e7987b481758c46a49f0301a8d" PRIMARY KEY (id);


--
-- Name: media_crew PK_5eac3317df46210d0bd248d432d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "PK_5eac3317df46210d0bd248d432d" PRIMARY KEY (id);


--
-- Name: episodes PK_6a003fda8b0473fffc39cb831c7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT "PK_6a003fda8b0473fffc39cb831c7" PRIMARY KEY (id);


--
-- Name: media_metadata PK_6c52273ad7331542bbce7ae4da1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "PK_6c52273ad7331542bbce7ae4da1" PRIMARY KEY (id);


--
-- Name: persons PK_74278d8812a049233ce41440ac7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT "PK_74278d8812a049233ce41440ac7" PRIMARY KEY (id);


--
-- Name: quality_profiles PK_77c6c3df9cc1a3f59166dc60764; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_profiles
    ADD CONSTRAINT "PK_77c6c3df9cc1a3f59166dc60764" PRIMARY KEY (id);


--
-- Name: commands PK_7ac292c3aa19300482b2b190d1e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commands
    ADD CONSTRAINT "PK_7ac292c3aa19300482b2b190d1e" PRIMARY KEY (id);


--
-- Name: livetv_guide_channels PK_91d0f326b295847759cd57ae98c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_channels
    ADD CONSTRAINT "PK_91d0f326b295847759cd57ae98c" PRIMARY KEY (id);


--
-- Name: media_files PK_93b4da6741cd150e76f9ac035d8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "PK_93b4da6741cd150e76f9ac035d8" PRIMARY KEY (id);


--
-- Name: pairing_requests PK_a088c08f7ba12dc7c2fa652cdb9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_requests
    ADD CONSTRAINT "PK_a088c08f7ba12dc7c2fa652cdb9" PRIMARY KEY (id);


--
-- Name: users PK_a3ffb1c0c8416b9fc6f907b7433; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);


--
-- Name: subtitle_providers PK_a9b2861711c6befdee0953d3994; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_providers
    ADD CONSTRAINT "PK_a9b2861711c6befdee0953d3994" PRIMARY KEY (id);


--
-- Name: quality_definitions PK_ac863a00261a01b83b7677c2039; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_definitions
    ADD CONSTRAINT "PK_ac863a00261a01b83b7677c2039" PRIMARY KEY (id);


--
-- Name: media_file_scans PK_b43c049e9581265f39b2eabc472; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_scans
    ADD CONSTRAINT "PK_b43c049e9581265f39b2eabc472" PRIMARY KEY (id);


--
-- Name: notification_connections PK_b77540d9ad6ca4ac46e5db9f26d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_connections
    ADD CONSTRAINT "PK_b77540d9ad6ca4ac46e5db9f26d" PRIMARY KEY (id);


--
-- Name: language_profiles PK_bf8bfa8caf3eece3d5224afe2be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_profiles
    ADD CONSTRAINT "PK_bf8bfa8caf3eece3d5224afe2be" PRIMARY KEY (id);


--
-- Name: roles PK_c1433d71a4838793a49dcad46ab; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY (id);


--
-- Name: request_comments PK_c2828c911aaf4d21408bc1e03e8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "PK_c2828c911aaf4d21408bc1e03e8" PRIMARY KEY (id);


--
-- Name: role_default_libraries PK_c7acdb10cc62d7d2a1b57443de3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "PK_c7acdb10cc62d7d2a1b57443de3" PRIMARY KEY ("roleId", "libraryId");


--
-- Name: media_servers PK_c7f56b22b880f2d948ffe50b83e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_servers
    ADD CONSTRAINT "PK_c7f56b22b880f2d948ffe50b83e" PRIMARY KEY (id);


--
-- Name: seasons PK_cb8ed53b5fe109dcd4a4449ec9d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT "PK_cb8ed53b5fe109dcd4a4449ec9d" PRIMARY KEY (id);


--
-- Name: livetv_sources PK_d63908dc94a2a3e9c02f8307d8e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_sources
    ADD CONSTRAINT "PK_d63908dc94a2a3e9c02f8307d8e" PRIMARY KEY (id);


--
-- Name: recommendation_dismissals PK_d64fd0160e105d4bcbaa1829711; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendation_dismissals
    ADD CONSTRAINT "PK_d64fd0160e105d4bcbaa1829711" PRIMARY KEY (id);


--
-- Name: library_user_access PK_dbd08312a26a16b56702859aa31; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "PK_dbd08312a26a16b56702859aa31" PRIMARY KEY (id);


--
-- Name: auto_approval_rules PK_e15edc2d64990ed78a3a34b12b8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_approval_rules
    ADD CONSTRAINT "PK_e15edc2d64990ed78a3a34b12b8" PRIMARY KEY (id);


--
-- Name: livetv_guide_sources PK_ef3aedcfce4e1a3e5c0f53f4aa6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_sources
    ADD CONSTRAINT "PK_ef3aedcfce4e1a3e5c0f53f4aa6" PRIMARY KEY (id);


--
-- Name: media PK_f4e0fcac36e050de337b670d8bd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "PK_f4e0fcac36e050de337b670d8bd" PRIMARY KEY (id);


--
-- Name: playback_qoe_events PK_playback_qoe_events; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_qoe_events
    ADD CONSTRAINT "PK_playback_qoe_events" PRIMARY KEY (id);


--
-- Name: playback_qoe_sessions PK_playback_qoe_sessions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_qoe_sessions
    ADD CONSTRAINT "PK_playback_qoe_sessions" PRIMARY KEY ("sessionId");


--
-- Name: media_metadata REL_62d457c000de0f01b2821a06ae; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "REL_62d457c000de0f01b2821a06ae" UNIQUE ("mediaId");


--
-- Name: quality_definitions UQ_5f4831d8cb9a9bc845a98006aeb; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_definitions
    ADD CONSTRAINT "UQ_5f4831d8cb9a9bc845a98006aeb" UNIQUE ("qualityId");


--
-- Name: roles UQ_648e3f5447f725579d7d4ffdfb7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE (name);


--
-- Name: persons UQ_677a19ecc46b5da7b1a4314c82b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT "UQ_677a19ecc46b5da7b1a4314c82b" UNIQUE (provider, "tmdbId");


--
-- Name: media_files UQ_89a6bf94332e9f2715c4d06b36c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "UQ_89a6bf94332e9f2715c4d06b36c" UNIQUE ("mediaId", "relativePath");


--
-- Name: app_settings UQ_975c2db59c65c05fd9c6b63a2ab; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT "UQ_975c2db59c65c05fd9c6b63a2ab" UNIQUE (key);


--
-- Name: libraries UQ_9fb3b11b4181af695b7cbf06d49; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "UQ_9fb3b11b4181af695b7cbf06d49" UNIQUE (name);


--
-- Name: pairing_requests UQ_afa67f327d1abc474061454d0e8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_requests
    ADD CONSTRAINT "UQ_afa67f327d1abc474061454d0e8" UNIQUE ("publicId");


--
-- Name: library_user_access UQ_b5a9b3a47bd7b60b3cd2a778b18; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "UQ_b5a9b3a47bd7b60b3cd2a778b18" UNIQUE ("libraryId", "userId");


--
-- Name: users UQ_fe0bb3f6520ee0469504521e710; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE (username);


--
-- Name: playlist_saves UQ_playlist_saves_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "UQ_playlist_saves_pair" UNIQUE ("userId", "playlistId");


--
-- Name: playlist_shares UQ_playlist_shares_playlist_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "UQ_playlist_shares_playlist_user" UNIQUE ("playlistId", "userId");


--
-- Name: plugin_packages UQ_plugin_packages_pluginId; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_packages
    ADD CONSTRAINT "UQ_plugin_packages_pluginId" UNIQUE ("pluginId");


--
-- Name: plugin_registrations UQ_plugin_registrations_pluginId; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_registrations
    ADD CONSTRAINT "UQ_plugin_registrations_pluginId" UNIQUE ("pluginId");


--
-- Name: user_follows UQ_user_follows_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "UQ_user_follows_pair" UNIQUE ("followerId", "followingId");


--
-- Name: _sqlx_migrations _sqlx_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._sqlx_migrations
    ADD CONSTRAINT _sqlx_migrations_pkey PRIMARY KEY (version);


--
-- Name: cleanup_candidates cleanup_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates
    ADD CONSTRAINT cleanup_candidates_pkey PRIMARY KEY (id);


--
-- Name: cleanup_exclusions cleanup_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions
    ADD CONSTRAINT cleanup_exclusions_pkey PRIMARY KEY (id);


--
-- Name: cleanup_rules cleanup_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_rules
    ADD CONSTRAINT cleanup_rules_pkey PRIMARY KEY (id);


--
-- Name: content_recommendations content_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT content_recommendations_pkey PRIMARY KEY (id);


--
-- Name: likes likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_pkey PRIMARY KEY (id);


--
-- Name: playback_history playback_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT playback_history_pkey PRIMARY KEY (id);


--
-- Name: playlist_items playlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT playlist_items_pkey PRIMARY KEY (id);


--
-- Name: playlist_saves playlist_saves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT playlist_saves_pkey PRIMARY KEY (id);


--
-- Name: playlist_shares playlist_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT playlist_shares_pkey PRIMARY KEY (id);


--
-- Name: playlists playlists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlists
    ADD CONSTRAINT playlists_pkey PRIMARY KEY (id);


--
-- Name: plugin_packages plugin_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_packages
    ADD CONSTRAINT plugin_packages_pkey PRIMARY KEY (id);


--
-- Name: plugin_registrations plugin_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_registrations
    ADD CONSTRAINT plugin_registrations_pkey PRIMARY KEY (id);


--
-- Name: plugin_scheduled_calls plugin_scheduled_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_scheduled_calls
    ADD CONSTRAINT plugin_scheduled_calls_pkey PRIMARY KEY ("pluginId", key);


--
-- Name: plugin_sources plugin_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_sources
    ADD CONSTRAINT plugin_sources_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: remote_control_grants remote_control_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_control_grants
    ADD CONSTRAINT remote_control_grants_pkey PRIMARY KEY (id);


--
-- Name: translation_providers translation_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_providers
    ADD CONSTRAINT translation_providers_pkey PRIMARY KEY (id);


--
-- Name: episode_markers uq_episode_marker_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT uq_episode_marker_type UNIQUE ("episodeId", type);


--
-- Name: user_follows user_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT user_follows_pkey PRIMARY KEY (id);


--
-- Name: IDX_227d23190a49e5c40c6a4ccedd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_227d23190a49e5c40c6a4ccedd" ON public.playback_states USING btree ("userId", "episodeId", completed);


--
-- Name: IDX_2675281c4a4e36f69c7a07bff7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_2675281c4a4e36f69c7a07bff7" ON public.recommendation_dismissals USING btree ("userId");


--
-- Name: IDX_28efb3a0402a49dca862fb62e6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_28efb3a0402a49dca862fb62e6" ON public.remote_control_grants USING btree ("granteeUserId");


--
-- Name: IDX_34d4b3c63c41ebc088ba3cfcdb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_34d4b3c63c41ebc088ba3cfcdb" ON public.remote_control_grants USING btree ("deviceId");


--
-- Name: IDX_35326c2d082f6619e340bc365f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_35326c2d082f6619e340bc365f" ON public.pairing_requests USING btree ("userId");


--
-- Name: IDX_590ddc457345bff7d6a9c70416; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_590ddc457345bff7d6a9c70416" ON public.pairing_requests USING btree ("deviceId");


--
-- Name: IDX_642c4b48b2c022d0baae6cc122; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_642c4b48b2c022d0baae6cc122" ON public.role_default_libraries USING btree ("roleId");


--
-- Name: IDX_6cc8df2e63ef1cd8cf28bfc854; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_6cc8df2e63ef1cd8cf28bfc854" ON public.media_cast USING btree ("mediaId");


--
-- Name: IDX_735e31a7f8cf53db91cc04339d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_735e31a7f8cf53db91cc04339d" ON public.remote_control_grants USING btree (code);


--
-- Name: IDX_7f3a35a769725163823e1162a9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7f3a35a769725163823e1162a9" ON public.role_default_libraries USING btree ("libraryId");


--
-- Name: IDX_8226529bf8b570cefa0bad2f96; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8226529bf8b570cefa0bad2f96" ON public.media_crew USING btree ("personId");


--
-- Name: IDX_95c3254f4a9023b7f30c81c25f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_95c3254f4a9023b7f30c81c25f" ON public.media_crew USING btree ("mediaId");


--
-- Name: IDX_a5a52f3d116c44c2944f0b1088; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a5a52f3d116c44c2944f0b1088" ON public.remote_control_grants USING btree ("ownerUserId");


--
-- Name: IDX_a650813641a2f4136cfd6ae5a8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a650813641a2f4136cfd6ae5a8" ON public.playback_states USING btree ("userId", "mediaId", completed);


--
-- Name: IDX_afa67f327d1abc474061454d0e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_afa67f327d1abc474061454d0e" ON public.pairing_requests USING btree ("publicId");


--
-- Name: IDX_cleanup_candidates_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_candidates_episodeId" ON public.cleanup_candidates USING btree ("episodeId");


--
-- Name: IDX_cleanup_candidates_ruleId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_candidates_ruleId" ON public.cleanup_candidates USING btree ("ruleId");


--
-- Name: IDX_cleanup_candidates_seasonId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_candidates_seasonId" ON public.cleanup_candidates USING btree ("seasonId");


--
-- Name: IDX_cleanup_exclusions_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_exclusions_episodeId" ON public.cleanup_exclusions USING btree ("episodeId");


--
-- Name: IDX_cleanup_exclusions_seasonId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_exclusions_seasonId" ON public.cleanup_exclusions USING btree ("seasonId");


--
-- Name: IDX_cleanup_exclusions_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cleanup_exclusions_userId" ON public.cleanup_exclusions USING btree ("userId");


--
-- Name: IDX_content_recommendations_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_content_recommendations_recipient" ON public.content_recommendations USING btree ("recipientId");


--
-- Name: IDX_eb83c621e1daf59140e1e1be0a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_eb83c621e1daf59140e1e1be0a" ON public.playback_states USING btree ("userId", completed, "lastPlayedAt");


--
-- Name: IDX_f702d61f4cd1578c889ab3cadc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f702d61f4cd1578c889ab3cadc" ON public.media_cast USING btree ("personId");


--
-- Name: IDX_likes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_likes_user" ON public.likes USING btree ("userId");


--
-- Name: IDX_livetv_channel_streams_channelId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_channel_streams_channelId" ON public.livetv_channel_streams USING btree ("channelId");


--
-- Name: IDX_livetv_channels_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_channels_group" ON public.livetv_channels USING btree ("groupName");


--
-- Name: IDX_livetv_channels_group_norm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_channels_group_norm" ON public.livetv_channels USING btree (lower(btrim(("groupName")::text)));


--
-- Name: IDX_livetv_channels_guide; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_channels_guide" ON public.livetv_channels USING btree ("guideChannelId");


--
-- Name: IDX_livetv_programs_channel_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_programs_channel_start" ON public.livetv_programs USING btree ("guideChannelId", "startsAt");


--
-- Name: IDX_livetv_programs_source_channel_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_programs_source_channel_start" ON public.livetv_programs USING btree ("guideSourceId", "guideChannelId", "startsAt");


--
-- Name: IDX_livetv_programs_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_livetv_programs_window" ON public.livetv_programs USING btree ("startsAt", "endsAt");


--
-- Name: IDX_media_addedById; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_media_addedById" ON public.media USING btree ("addedById");


--
-- Name: IDX_media_files_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_media_files_episodeId" ON public.media_files USING btree ("episodeId");


--
-- Name: IDX_media_libraryId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_media_libraryId" ON public.media USING btree ("libraryId");


--
-- Name: IDX_playback_history_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_history_episodeId" ON public.playback_history USING btree ("episodeId");


--
-- Name: IDX_playback_history_mediaId_playedAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_history_mediaId_playedAt" ON public.playback_history USING btree ("mediaId", "playedAt");


--
-- Name: IDX_playback_history_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_history_userId" ON public.playback_history USING btree ("userId");


--
-- Name: IDX_playback_qoe_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_qoe_events_session" ON public.playback_qoe_events USING btree ("sessionId");


--
-- Name: IDX_playback_qoe_sessions_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_qoe_sessions_device" ON public.playback_qoe_sessions USING btree ("deviceLabel");


--
-- Name: IDX_playback_qoe_sessions_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_qoe_sessions_last_seen" ON public.playback_qoe_sessions USING btree ("lastSeenAt");


--
-- Name: IDX_playback_qoe_sessions_playback; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_qoe_sessions_playback" ON public.playback_qoe_sessions USING btree ("userId", "playbackId");


--
-- Name: IDX_playback_qoe_sessions_playback_verdict; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playback_qoe_sessions_playback_verdict" ON public.playback_qoe_sessions USING btree ("playbackVerdict");


--
-- Name: IDX_playlist_items_addedById; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_items_addedById" ON public.playlist_items USING btree ("addedById");


--
-- Name: IDX_playlist_items_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_items_episodeId" ON public.playlist_items USING btree ("episodeId");


--
-- Name: IDX_playlist_items_mediaId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_items_mediaId" ON public.playlist_items USING btree ("mediaId");


--
-- Name: IDX_playlist_items_playlist_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_items_playlist_position" ON public.playlist_items USING btree ("playlistId", "position");


--
-- Name: IDX_playlist_saves_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_saves_user" ON public.playlist_saves USING btree ("userId");


--
-- Name: IDX_playlist_shares_playlistId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_shares_playlistId" ON public.playlist_shares USING btree ("playlistId");


--
-- Name: IDX_playlist_shares_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlist_shares_userId" ON public.playlist_shares USING btree ("userId");


--
-- Name: IDX_playlists_ownerId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_playlists_ownerId" ON public.playlists USING btree ("ownerId");


--
-- Name: IDX_plugin_scheduled_calls_runAt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_plugin_scheduled_calls_runAt" ON public.plugin_scheduled_calls USING btree ("runAt");


--
-- Name: IDX_refresh_tokens_tokenHash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_refresh_tokens_tokenHash" ON public.refresh_tokens USING btree ("tokenHash");


--
-- Name: IDX_refresh_tokens_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_refresh_tokens_userId" ON public.refresh_tokens USING btree ("userId");


--
-- Name: IDX_requests_mediaId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_requests_mediaId" ON public.requests USING btree ("mediaId");


--
-- Name: IDX_requests_userId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_requests_userId" ON public.requests USING btree ("userId");


--
-- Name: IDX_seasons_mediaId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_seasons_mediaId" ON public.seasons USING btree ("mediaId");


--
-- Name: IDX_subtitle_files_episodeId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_subtitle_files_episodeId" ON public.subtitle_files USING btree ("episodeId");


--
-- Name: IDX_subtitle_files_mediaFileId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_subtitle_files_mediaFileId" ON public.subtitle_files USING btree ("mediaFileId");


--
-- Name: IDX_subtitle_files_mediaId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_subtitle_files_mediaId" ON public.subtitle_files USING btree ("mediaId");


--
-- Name: IDX_user_follows_follower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_user_follows_follower" ON public.user_follows USING btree ("followerId");


--
-- Name: IDX_user_follows_following; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_user_follows_following" ON public.user_follows USING btree ("followingId");


--
-- Name: UQ_cleanup_candidates_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_cleanup_candidates_scope" ON public.cleanup_candidates USING btree ("mediaId", "seasonId", "episodeId") NULLS NOT DISTINCT;


--
-- Name: UQ_cleanup_exclusions_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_cleanup_exclusions_scope" ON public.cleanup_exclusions USING btree ("mediaId", "seasonId", "episodeId") NULLS NOT DISTINCT;


--
-- Name: UQ_likes_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_likes_episode" ON public.likes USING btree ("userId", "episodeId") WHERE ("episodeId" IS NOT NULL);


--
-- Name: UQ_likes_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_likes_movie" ON public.likes USING btree ("userId", "mediaId") WHERE (("seasonId" IS NULL) AND ("episodeId" IS NULL));


--
-- Name: UQ_likes_season; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_likes_season" ON public.likes USING btree ("userId", "seasonId") WHERE ("seasonId" IS NOT NULL);


--
-- Name: UQ_livetv_group_access_user_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_livetv_group_access_user_group" ON public.livetv_group_access USING btree ("userId", "groupName");


--
-- Name: UQ_livetv_guide_channel_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_livetv_guide_channel_source_id" ON public.livetv_guide_channels USING btree ("guideSourceId", "channelId");


--
-- Name: UQ_livetv_pref_user_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_livetv_pref_user_channel" ON public.livetv_user_channel_prefs USING btree ("userId", "channelId");


--
-- Name: UQ_livetv_stream_source_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_livetv_stream_source_external" ON public.livetv_channel_streams USING btree ("sourceId", "externalId");


--
-- Name: UQ_media_file_scans_media_file; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_media_file_scans_media_file" ON public.media_file_scans USING btree ("mediaFileId");


--
-- Name: UQ_media_type_tmdbId; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_media_type_tmdbId" ON public.media USING btree (type, "tmdbId");


--
-- Name: UQ_playlist_items_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_playlist_items_episode" ON public.playlist_items USING btree ("playlistId", "episodeId") WHERE ("episodeId" IS NOT NULL);


--
-- Name: UQ_playlist_items_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_playlist_items_movie" ON public.playlist_items USING btree ("playlistId", "mediaId") WHERE ("episodeId" IS NULL);


--
-- Name: UQ_recommendation_dismissals_user_media; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_recommendation_dismissals_user_media" ON public.recommendation_dismissals USING btree ("userId", "mediaId");


--
-- Name: idx_episodes_season_hasfile_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_episodes_season_hasfile_end ON public.episodes USING btree ("seasonId", "hasFile", "endEpisodeNumber");


--
-- Name: idx_media_search_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_search_vector ON public.media USING gin ("searchVector");


--
-- Name: idx_persons_search_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persons_search_vector ON public.persons USING gin ("searchVector");


--
-- Name: idx_playback_user_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_playback_user_episode ON public.playback_states USING btree ("userId", "episodeId") WHERE ("episodeId" IS NOT NULL);


--
-- Name: idx_playback_user_movie; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_playback_user_movie ON public.playback_states USING btree ("userId", "mediaId") WHERE ("episodeId" IS NULL);


--
-- Name: media media_search_vector; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", overview ON public.media FOR EACH ROW EXECUTE FUNCTION public.media_search_vector_update();


--
-- Name: persons persons_search_vector; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER persons_search_vector BEFORE INSERT OR UPDATE OF name ON public.persons FOR EACH ROW EXECUTE FUNCTION public.persons_search_vector_update();


--
-- Name: app_settings set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: auto_approval_rules set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.auto_approval_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cleanup_rules set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.cleanup_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: commands set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.commands FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: content_recommendations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.content_recommendations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: custom_formats set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.custom_formats FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: episode_markers set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.episode_markers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: episodes set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.episodes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: language_profiles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.language_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: libraries set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.libraries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: library_user_access set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.library_user_access FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: likes set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.likes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_channel_streams set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_channel_streams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_channels set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_group_access set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_group_access FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_guide_channels set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_guide_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_guide_sources set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_guide_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_programs set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_programs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_sources set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_user_channel_prefs set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.livetv_user_channel_prefs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_cast set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_cast FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_crew set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_crew FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_file_scans set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_file_scans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_files set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_files FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_metadata set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_metadata FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_servers set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.media_servers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: notification_connections set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.notification_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pairing_requests set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.pairing_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: persons set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.persons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: playback_states set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.playback_states FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: playlist_items set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.playlist_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: playlist_saves set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.playlist_saves FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: playlist_shares set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.playlist_shares FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: playlists set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.playlists FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plugin_packages set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plugin_packages FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plugin_registrations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plugin_registrations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plugin_sources set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plugin_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quality_definitions set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.quality_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quality_profiles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.quality_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: recommendation_dismissals set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.recommendation_dismissals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: refresh_tokens set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.refresh_tokens FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: remote_control_grants set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.remote_control_grants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: request_comments set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.request_comments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: requests set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: roles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: seasons set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.seasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subtitle_blacklist set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.subtitle_blacklist FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subtitle_files set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.subtitle_files FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subtitle_providers set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.subtitle_providers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: translation_providers set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.translation_providers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_follows set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.user_follows FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: livetv_user_channel_prefs FK_060071713679f7fee42720c6753; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "FK_060071713679f7fee42720c6753" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subtitle_provider_stats FK_0bd2f50e4e0a883545fde657094; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_provider_stats
    ADD CONSTRAINT "FK_0bd2f50e4e0a883545fde657094" FOREIGN KEY ("providerId") REFERENCES public.subtitle_providers(id) ON DELETE CASCADE;


--
-- Name: playlist_items FK_0f9dbadfd3458af1e6bc49c93e3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_0f9dbadfd3458af1e6bc49c93e3" FOREIGN KEY ("addedById") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: libraries FK_1127dccf41a2959b675a0aa8891; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "FK_1127dccf41a2959b675a0aa8891" FOREIGN KEY ("defaultQualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;


--
-- Name: playlist_items FK_16f8c7b6e4824b9ccca31b9616b; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_16f8c7b6e4824b9ccca31b9616b" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: playlist_items FK_1a5c30e99b5283b5653ee29b6b5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_1a5c30e99b5283b5653ee29b6b5" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;


--
-- Name: content_recommendations FK_1a6417072770a4914bd315ab750; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_1a6417072770a4914bd315ab750" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: subtitle_files FK_295bae34d5648dd18b16747db4a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_295bae34d5648dd18b16747db4a" FOREIGN KEY ("translationProviderId") REFERENCES public.translation_providers(id) ON DELETE SET NULL;


--
-- Name: content_recommendations FK_2e975a73e827bc421da61575b7a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_2e975a73e827bc421da61575b7a" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: library_user_access FK_32958f30dee035e832a2234763d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "FK_32958f30dee035e832a2234763d" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users FK_368e146b785b574f42ae9e53d5e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "FK_368e146b785b574f42ae9e53d5e" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON DELETE SET NULL;


--
-- Name: subtitle_files FK_38e603e48e77e016bc9cc88cafd; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_38e603e48e77e016bc9cc88cafd" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: requests FK_4340ea3e8eb488c8cb4edbcc468; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_4340ea3e8eb488c8cb4edbcc468" FOREIGN KEY ("qualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;


--
-- Name: content_recommendations FK_461751303606d68d0c5666347d7; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_461751303606d68d0c5666347d7" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: livetv_channel_streams FK_59af5c2b4a5f3029361bda58aff; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "FK_59af5c2b4a5f3029361bda58aff" FOREIGN KEY ("channelId") REFERENCES public.livetv_channels(id) ON DELETE CASCADE;


--
-- Name: playlist_shares FK_5d4f9a22dd268ce08eb2319d0c8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "FK_5d4f9a22dd268ce08eb2319d0c8" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;


--
-- Name: seasons FK_5e53591a9fd2dbb7f297863ecc6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT "FK_5e53591a9fd2dbb7f297863ecc6" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens FK_610102b60fea1455310ccd299de; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playlist_shares FK_62c91d23418a7ae8115f07f64d9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_shares
    ADD CONSTRAINT "FK_62c91d23418a7ae8115f07f64d9" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: media_metadata FK_62d457c000de0f01b2821a06ae6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_metadata
    ADD CONSTRAINT "FK_62d457c000de0f01b2821a06ae6" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: user_follows FK_6300484b604263eaae8a6aab88d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "FK_6300484b604263eaae8a6aab88d" FOREIGN KEY ("followerId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: role_default_libraries FK_642c4b48b2c022d0baae6cc1226; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "FK_642c4b48b2c022d0baae6cc1226" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: library_user_access FK_644d5c1672d256a02073eec76d6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_user_access
    ADD CONSTRAINT "FK_644d5c1672d256a02073eec76d6" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE CASCADE;


--
-- Name: likes FK_65ef9a90fa855c14dd0cd896c8b; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_65ef9a90fa855c14dd0cd896c8b" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: likes FK_67214b2270f001c5a96a3626315; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_67214b2270f001c5a96a3626315" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: libraries FK_68b96c817fab521697d7a087685; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT "FK_68b96c817fab521697d7a087685" FOREIGN KEY ("defaultLanguageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;


--
-- Name: requests FK_6ac8127d11e259d8feb3a1c77c4; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_6ac8127d11e259d8feb3a1c77c4" FOREIGN KEY ("languageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;


--
-- Name: media_files FK_6b32aaee05883e7fc772e29db28; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "FK_6b32aaee05883e7fc772e29db28" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE SET NULL;


--
-- Name: media_cast FK_6cc8df2e63ef1cd8cf28bfc854a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "FK_6cc8df2e63ef1cd8cf28bfc854a" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: media FK_6cde0e5015d20edcd45f593d27b; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_6cde0e5015d20edcd45f593d27b" FOREIGN KEY ("qualityProfileId") REFERENCES public.quality_profiles(id) ON DELETE SET NULL;


--
-- Name: media FK_724fe2622945e05c195981e5093; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_724fe2622945e05c195981e5093" FOREIGN KEY ("addedById") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: playback_states FK_742bc2fe139bc8334edab814e16; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_742bc2fe139bc8334edab814e16" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: livetv_channel_streams FK_7c1c468ee5ade7295749ab9e1e9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_channel_streams
    ADD CONSTRAINT "FK_7c1c468ee5ade7295749ab9e1e9" FOREIGN KEY ("sourceId") REFERENCES public.livetv_sources(id) ON DELETE CASCADE;


--
-- Name: user_follows FK_7c6c27f12c4e972eab4b3aaccbf; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_follows
    ADD CONSTRAINT "FK_7c6c27f12c4e972eab4b3aaccbf" FOREIGN KEY ("followingId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: role_default_libraries FK_7f3a35a769725163823e1162a98; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_default_libraries
    ADD CONSTRAINT "FK_7f3a35a769725163823e1162a98" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: media_crew FK_8226529bf8b570cefa0bad2f96a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "FK_8226529bf8b570cefa0bad2f96a" FOREIGN KEY ("personId") REFERENCES public.persons(id) ON DELETE CASCADE;


--
-- Name: request_comments FK_83f2ec25950f32fb4930d0b733f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "FK_83f2ec25950f32fb4930d0b733f" FOREIGN KEY ("requestId") REFERENCES public.requests(id) ON DELETE CASCADE;


--
-- Name: playback_states FK_868d7ead9d6748409edee2b7b4a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_868d7ead9d6748409edee2b7b4a" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: likes FK_8b1354ded3e5cd533bc0d04ce18; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_8b1354ded3e5cd533bc0d04ce18" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: requests FK_93dd6ea962d8a48df3f7448bdd5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_93dd6ea962d8a48df3f7448bdd5" FOREIGN KEY ("approvedById") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: playlist_saves FK_957d1f3537c85497076254ac1e8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "FK_957d1f3537c85497076254ac1e8" FOREIGN KEY ("playlistId") REFERENCES public.playlists(id) ON DELETE CASCADE;


--
-- Name: media_crew FK_95c3254f4a9023b7f30c81c25fa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_crew
    ADD CONSTRAINT "FK_95c3254f4a9023b7f30c81c25fa" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: livetv_guide_channels FK_9919469c4f149762ee9c3265564; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_channels
    ADD CONSTRAINT "FK_9919469c4f149762ee9c3265564" FOREIGN KEY ("guideSourceId") REFERENCES public.livetv_guide_sources(id) ON DELETE CASCADE;


--
-- Name: playlist_items FK_9dcd364d418c539e74b7f57ad36; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_items
    ADD CONSTRAINT "FK_9dcd364d418c539e74b7f57ad36" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: subtitle_files FK_9fd8637cb821ddec6f57b422785; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_9fd8637cb821ddec6f57b422785" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE SET NULL;


--
-- Name: content_recommendations FK_a28f439c529ee2c6540d329e544; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_a28f439c529ee2c6540d329e544" FOREIGN KEY ("senderId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playlists FK_aa5d498a2f045be2fb71ef98d45; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlists
    ADD CONSTRAINT "FK_aa5d498a2f045be2fb71ef98d45" FOREIGN KEY ("ownerId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: media_file_scans FK_af6e69aca953537e68d29c82d0c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_scans
    ADD CONSTRAINT "FK_af6e69aca953537e68d29c82d0c" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;


--
-- Name: playback_states FK_b01f3bfb9c8dcbca9c0030341b3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_b01f3bfb9c8dcbca9c0030341b3" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;


--
-- Name: episodes FK_b312e9d94c9b80adee2330b73e9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT "FK_b312e9d94c9b80adee2330b73e9" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: episode_markers FK_b4ef632c24f24a5e7b9c4e18a4e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_markers
    ADD CONSTRAINT "FK_b4ef632c24f24a5e7b9c4e18a4e" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: playback_states FK_badc34ed0e95631af673a5d981d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_states
    ADD CONSTRAINT "FK_badc34ed0e95631af673a5d981d" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: requests FK_be846ad4b43f40acc7034ef7f40; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_be846ad4b43f40acc7034ef7f40" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: media FK_bf4a42ddf842b0536fcd81b4f2b; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_bf4a42ddf842b0536fcd81b4f2b" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE RESTRICT;


--
-- Name: request_comments FK_c03e315afb98705e644633d80b7; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_comments
    ADD CONSTRAINT "FK_c03e315afb98705e644633d80b7" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: requests FK_c6cb47d29a66465e0489a770be8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_c6cb47d29a66465e0489a770be8" FOREIGN KEY ("libraryId") REFERENCES public.libraries(id) ON DELETE SET NULL;


--
-- Name: livetv_group_access FK_c8018529d697ca2f8b6db09a809; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_group_access
    ADD CONSTRAINT "FK_c8018529d697ca2f8b6db09a809" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: likes FK_cfd8e81fac09d7339a32e57d904; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT "FK_cfd8e81fac09d7339a32e57d904" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: requests FK_d9b24c2cc987bf39be9bd481fc5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT "FK_d9b24c2cc987bf39be9bd481fc5" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE SET NULL;


--
-- Name: media_files FK_d9ebcae21d44cc576a4f569486d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT "FK_d9ebcae21d44cc576a4f569486d" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: subtitle_blacklist FK_e0508dc1dd297c4cc01044f228c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_blacklist
    ADD CONSTRAINT "FK_e0508dc1dd297c4cc01044f228c" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE SET NULL;


--
-- Name: livetv_programs FK_e286f77ce01c33b14526a8090d7; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_programs
    ADD CONSTRAINT "FK_e286f77ce01c33b14526a8090d7" FOREIGN KEY ("guideSourceId") REFERENCES public.livetv_guide_sources(id) ON DELETE CASCADE;


--
-- Name: livetv_guide_sources FK_e84c176ef1ef24a8c523d86bc95; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_guide_sources
    ADD CONSTRAINT "FK_e84c176ef1ef24a8c523d86bc95" FOREIGN KEY ("sourceId") REFERENCES public.livetv_sources(id) ON DELETE CASCADE;


--
-- Name: content_recommendations FK_ee17496f10af9bad93ad1b94f2d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recommendations
    ADD CONSTRAINT "FK_ee17496f10af9bad93ad1b94f2d" FOREIGN KEY ("recipientId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: livetv_user_channel_prefs FK_f4cc72c18df00113d4e17fa598c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livetv_user_channel_prefs
    ADD CONSTRAINT "FK_f4cc72c18df00113d4e17fa598c" FOREIGN KEY ("channelId") REFERENCES public.livetv_channels(id) ON DELETE CASCADE;


--
-- Name: media_cast FK_f702d61f4cd1578c889ab3cadca; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cast
    ADD CONSTRAINT "FK_f702d61f4cd1578c889ab3cadca" FOREIGN KEY ("personId") REFERENCES public.persons(id) ON DELETE CASCADE;


--
-- Name: subtitle_files FK_fad8b97f2b3863e76aae917e94d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtitle_files
    ADD CONSTRAINT "FK_fad8b97f2b3863e76aae917e94d" FOREIGN KEY ("mediaFileId") REFERENCES public.media_files(id) ON DELETE CASCADE;


--
-- Name: media FK_fb0eb80298f112ac0bfb103da0e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT "FK_fb0eb80298f112ac0bfb103da0e" FOREIGN KEY ("languageProfileId") REFERENCES public.language_profiles(id) ON DELETE SET NULL;


--
-- Name: playlist_saves FK_fe0902ebcd7a31e03080d4bf4af; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playlist_saves
    ADD CONSTRAINT "FK_fe0902ebcd7a31e03080d4bf4af" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playback_qoe_events FK_playback_qoe_events_session; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_qoe_events
    ADD CONSTRAINT "FK_playback_qoe_events_session" FOREIGN KEY ("sessionId") REFERENCES public.playback_qoe_sessions("sessionId") ON DELETE CASCADE;


--
-- Name: cleanup_candidates cleanup_candidates_episodeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates
    ADD CONSTRAINT "cleanup_candidates_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: cleanup_candidates cleanup_candidates_mediaId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates
    ADD CONSTRAINT "cleanup_candidates_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: cleanup_candidates cleanup_candidates_ruleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates
    ADD CONSTRAINT "cleanup_candidates_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public.cleanup_rules(id) ON DELETE CASCADE;


--
-- Name: cleanup_candidates cleanup_candidates_seasonId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_candidates
    ADD CONSTRAINT "cleanup_candidates_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: cleanup_exclusions cleanup_exclusions_episodeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions
    ADD CONSTRAINT "cleanup_exclusions_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: cleanup_exclusions cleanup_exclusions_mediaId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions
    ADD CONSTRAINT "cleanup_exclusions_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: cleanup_exclusions cleanup_exclusions_seasonId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions
    ADD CONSTRAINT "cleanup_exclusions_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: cleanup_exclusions cleanup_exclusions_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_exclusions
    ADD CONSTRAINT "cleanup_exclusions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: playback_history playback_history_episodeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT "playback_history_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: playback_history playback_history_mediaId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT "playback_history_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: playback_history playback_history_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playback_history
    ADD CONSTRAINT "playback_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



/* eslint-disable @typescript-eslint/no-explicit-any */
import ExternalAPI from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import availabilitySync from '@server/lib/availabilitySync';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';

export interface JellyfinUserResponse {
  Name: string;
  ServerId: string;
  ServerName: string;
  Id: string;
  Configuration: {
    GroupedFolders: string[];
  };
  Policy: {
    IsAdministrator: boolean;
  };
  PrimaryImageTag?: string;
}

export interface JellyfinDevice {
  Id: string;
  Name: string;
  LastUserName: string;
  AppName: string;
  AppVersion: string;
  LastUserId: string;
  DateLastActivity: string;
  Capabilities: Record<string, unknown>;
}

export interface JellyfinDevicesResponse {
  Items: JellyfinDevice[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface JellyfinLoginResponse {
  User: JellyfinUserResponse;
  AccessToken: string;
}

export interface QuickConnectInitiateResponse {
  Secret: string;
  Code: string;
  DateAdded: string;
}

export interface QuickConnectStatusResponse {
  Authenticated: boolean;
  Secret: string;
  Code: string;
  DeviceId: string;
  DeviceName: string;
  AppName: string;
  AppVersion: string;
  DateAdded: string;
}

export interface JellyfinUserListResponse {
  users: JellyfinUserResponse[];
}

interface JellyfinMediaFolder {
  Name: string;
  Id: string;
  Type: string;
  CollectionType: string;
}

export interface JellyfinLibrary {
  type: 'show' | 'movie';
  key: string;
  title: string;
  agent: string;
}

export interface JellyfinLibraryItem {
  Name: string;
  Id: string;
  HasSubtitles: boolean;
  Type: 'Movie' | 'Episode' | 'Season' | 'Series';
  LocationType: 'FileSystem' | 'Offline' | 'Remote' | 'Virtual';
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  ParentIndexNumber?: number;
  MediaType: string;
}

export interface JellyfinMediaStream {
  Codec: string;
  Type: 'Video' | 'Audio' | 'Subtitle';
  Height?: number;
  Width?: number;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  Language?: string;
  DisplayTitle: string;
}

export interface JellyfinMediaSource {
  Protocol: string;
  Id: string;
  Path: string;
  Type: string;
  VideoType: string;
  MediaStreams: JellyfinMediaStream[];
}

export interface JellyfinLibraryItemExtended extends JellyfinLibraryItem {
  ProviderIds: {
    Tmdb?: string;
    TheMovieDb?: string;
    Imdb?: string;
    Tvdb?: string;
    AniDB?: string;
  };
  MediaSources?: JellyfinMediaSource[];
  Width?: number;
  Height?: number;
  IsHD?: boolean;
  DateCreated?: string;
}

export interface JellyfinWatchedItem {
  name: string;
  type: 'movie' | 'tv';
  year?: number;
  tmdbId?: number;
  genres: string[];
  favorite: boolean;
}

export interface JellyfinLibraryTitle {
  name: string;
  type: 'movie' | 'tv';
  year?: number;
  tmdbId?: number;
  genres: string[];
  runtimeMinutes?: number;
  rating?: number;
}

interface JellyfinUserItem extends JellyfinLibraryItemExtended {
  ProductionYear?: number;
  Genres?: string[];
  CommunityRating?: number;
  RunTimeTicks?: number;
  UserData?: {
    IsFavorite?: boolean;
    Played?: boolean;
    LastPlayedDate?: string;
  };
}

type EpisodeReturn<T> = T extends { includeMediaInfo: true }
  ? JellyfinLibraryItemExtended[]
  : JellyfinLibraryItem[];

export interface JellyfinItemsReponse {
  Items: JellyfinLibraryItemExtended[];
  TotalRecordCount: number;
  StartIndex: number;
}

class JellyfinAPI extends ExternalAPI {
  private userId?: string;
  private mediaServerType: MediaServerType;

  constructor(
    jellyfinHost: string,
    authToken?: string | null,
    deviceId?: string | null
  ) {
    const settings = getSettings();
    const safeDeviceId =
      deviceId && deviceId.length > 0
        ? deviceId
        : Buffer.from('BOT_seerr').toString('base64');

    const version =
      settings.main.mediaServerType === MediaServerType.EMBY
        ? '1.0.0'
        : getAppVersion();

    let authHeaderVal = `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${safeDeviceId}", Version="${version}"`;
    if (authToken) {
      authHeaderVal += `, Token="${authToken}"`;
    }

    super(
      jellyfinHost,
      {},
      {
        headers: {
          Authorization: authHeaderVal,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    this.mediaServerType = settings.main.mediaServerType;
  }

  public async login(
    Username?: string,
    Password?: string,
    ClientIP?: string
  ): Promise<JellyfinLoginResponse> {
    const authenticate = async (useHeaders: boolean) => {
      const headers =
        useHeaders && ClientIP ? { 'X-Forwarded-For': ClientIP } : {};

      return this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateByName',
        {
          Username,
          Pw: Password,
        },
        { headers }
      );
    };

    try {
      return await authenticate(true);
    } catch (e) {
      logger.debug('Failed to authenticate with headers', {
        label: 'Jellyfin API',
        error: e.response?.statusText,
        ip: ClientIP,
      });

      if (!e.response?.status) {
        throw new ApiError(404, ApiErrorCode.InvalidUrl);
      }

      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }
    }

    try {
      return await authenticate(false);
    } catch (e) {
      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }

      logger.error(
        `Something went wrong while authenticating with the Jellyfin server: ${e.message}`,
        {
          label: 'Jellyfin API',
          error: e.response?.status,
          ip: ClientIP,
        }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async initiateQuickConnect(): Promise<QuickConnectInitiateResponse> {
    try {
      const response = await this.post<QuickConnectInitiateResponse>(
        '/QuickConnect/Initiate'
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while initiating Quick Connect: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async checkQuickConnect(
    secret: string
  ): Promise<QuickConnectStatusResponse> {
    try {
      const response = await this.get<QuickConnectStatusResponse>(
        '/QuickConnect/Connect',
        { params: { secret } }
      );

      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while getting Quick Connect status: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async authenticateQuickConnect(
    secret: string
  ): Promise<JellyfinLoginResponse> {
    try {
      const response = await this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateWithQuickConnect',
        { Secret: secret }
      );
      return response;
    } catch (e) {
      logger.error(
        `Something went wrong while authenticating with Quick Connect: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public setUserId(userId: string): void {
    this.userId = userId;
    return;
  }

  public async getSystemInfo(): Promise<any> {
    try {
      const systemInfoResponse = await this.get<any>('/System/Info');

      return systemInfoResponse;
    } catch (e) {
      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getServerName(): Promise<string> {
    try {
      const serverResponse = await this.get<JellyfinUserResponse>(
        '/System/Info/Public'
      );

      return serverResponse.ServerName;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the server name from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }
  }

  public async getUsers(): Promise<JellyfinUserListResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse[]>(`/Users`);

      return { users: userReponse };
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getUser(): Promise<JellyfinUserResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse>(
        `/Users/${this.userId ?? 'Me'}`
      );
      return userReponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getLibraries(): Promise<JellyfinLibrary[]> {
    try {
      const mediaFolderResponse = await this.get<any>(`/Library/MediaFolders`);

      return this.mapLibraries(mediaFolderResponse.Items);
    } catch {
      // fallback to user views to get libraries
      // this only and maybe/depending on factors affects LDAP users
      try {
        const mediaFolderResponse = await this.get<any>(
          `/Users/${this.userId ?? 'Me'}/Views`
        );

        return this.mapLibraries(mediaFolderResponse.Items);
      } catch (e) {
        logger.error(
          `Something went wrong while getting libraries from the Jellyfin server: ${e.message}`,
          {
            label: 'Jellyfin API',
            error: e.response?.status,
          }
        );

        if (!e.response) {
          throw new ApiError(502, ApiErrorCode.ConnectionError);
        }

        return [];
      }
    }
  }

  private mapLibraries(mediaFolders: JellyfinMediaFolder[]): JellyfinLibrary[] {
    const excludedTypes = [
      'music',
      'books',
      'musicvideos',
      'homevideos',
      'boxsets',
    ];

    return mediaFolders
      .filter((Item: JellyfinMediaFolder) => {
        return (
          Item.Type === 'CollectionFolder' &&
          !excludedTypes.includes(Item.CollectionType)
        );
      })
      .map((Item: JellyfinMediaFolder) => {
        return <JellyfinLibrary>{
          key: Item.Id,
          title: Item.Name,
          type: Item.CollectionType === 'movies' ? 'movie' : 'show',
          agent: 'jellyfin',
        };
      });
  }

  public async getLibraryContents(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      const libraryItemsResponse = await this.get<any>(
        `/Items?SortBy=SortName&SortOrder=Ascending&IncludeItemTypes=Series,Movie,Others&Recursive=true&StartIndex=0&ParentId=${id}&collapseBoxSetItems=false`
      );

      return libraryItemsResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e?.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getRecentlyAdded(id: string): Promise<JellyfinLibraryItem[]> {
    try {
      const endpoint =
        this.mediaServerType === MediaServerType.JELLYFIN
          ? `/Items/Latest`
          : `/Users/${this.userId}/Items/Latest`;
      const itemResponse = await this.get<any>(
        `${endpoint}?Limit=12&ParentId=${id}${
          this.mediaServerType === MediaServerType.JELLYFIN
            ? `&userId=${this.userId ?? 'Me'}`
            : ''
        }`
      );

      return itemResponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Returns what a user has recently watched, newest first: played movies,
   * series with played episodes, and anything marked as a favorite.
   * Requires an admin API key so that any user's history can be read.
   * Pass `libraryIds` to only look inside those libraries.
   */
  public async getUserWatchHistory(
    userId: string,
    {
      movieLimit = 40,
      seriesLimit = 25,
      libraryIds,
    }: { movieLimit?: number; seriesLimit?: number; libraryIds?: string[] } = {}
  ): Promise<JellyfinWatchedItem[]> {
    if (libraryIds && !libraryIds.length) {
      return [];
    }

    const getItems = (params: Record<string, string | number>) =>
      this.getUserItems(userId, params);
    const query = (params: Record<string, string | number>) =>
      this.queryUserItems(
        userId,
        params,
        libraryIds,
        (item) => item.UserData?.LastPlayedDate ?? ''
      );

    const fields = 'ProviderIds,Genres,ProductionYear';

    try {
      const [movies, episodes, favorites] = await Promise.all([
        query({
          IncludeItemTypes: 'Movie',
          Filters: 'IsPlayed',
          SortBy: 'DatePlayed',
          SortOrder: 'Descending',
          Recursive: 'true',
          Limit: movieLimit,
          Fields: fields,
        }),
        // Series only count as "played" once every episode is watched, so
        // look at played episodes instead and collect their series.
        query({
          IncludeItemTypes: 'Episode',
          Filters: 'IsPlayed',
          SortBy: 'DatePlayed',
          SortOrder: 'Descending',
          Recursive: 'true',
          Limit: 400,
        }),
        query({
          IncludeItemTypes: 'Movie,Series',
          Filters: 'IsFavorite',
          Recursive: 'true',
          Limit: 50,
          Fields: fields,
        }),
      ]);

      const seriesIds = [
        ...new Set(
          episodes
            .map((episode) => episode.SeriesId)
            .filter((id): id is string => !!id)
        ),
      ].slice(0, seriesLimit);

      const series = seriesIds.length
        ? (
            await getItems({
              Ids: seriesIds.join(','),
              Fields: fields,
            })
          ).Items.sort(
            (a, b) => seriesIds.indexOf(a.Id) - seriesIds.indexOf(b.Id)
          )
        : [];

      const favoriteIds = new Set(favorites.map((item) => item.Id));
      const seen = new Set<string>();
      const result: JellyfinWatchedItem[] = [];

      for (const item of [...favorites, ...movies, ...series]) {
        if (seen.has(item.Id)) {
          continue;
        }
        seen.add(item.Id);

        const tmdbId = Number(
          item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb
        );

        result.push({
          name: item.Name,
          type: item.Type === 'Movie' ? 'movie' : 'tv',
          year: item.ProductionYear,
          tmdbId: tmdbId > 0 ? tmdbId : undefined,
          genres: item.Genres ?? [],
          favorite: favoriteIds.has(item.Id),
        });
      }

      return result;
    } catch (e) {
      logger.error(
        `Something went wrong while getting watch history from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  /**
   * Returns movies and series on the server the user hasn't finished: some
   * recently added and some of the best rated. Used to answer "what can I
   * watch right now" questions.
   */
  public async getUnwatchedItems(
    userId: string,
    { limit = 60, libraryIds }: { limit?: number; libraryIds?: string[] } = {}
  ): Promise<JellyfinLibraryTitle[]> {
    if (libraryIds && !libraryIds.length) {
      return [];
    }

    const base = {
      IncludeItemTypes: 'Movie,Series',
      Filters: 'IsUnplayed',
      Recursive: 'true',
      Limit: limit,
      Fields: 'ProviderIds,Genres,ProductionYear',
    };

    try {
      const [recent, topRated] = await Promise.all([
        this.queryUserItems(
          userId,
          { ...base, SortBy: 'DateCreated', SortOrder: 'Descending' },
          libraryIds,
          (item) => item.DateCreated ?? ''
        ),
        this.queryUserItems(
          userId,
          { ...base, SortBy: 'CommunityRating', SortOrder: 'Descending' },
          libraryIds,
          (item) => String(item.CommunityRating ?? 0).padStart(5, '0')
        ),
      ]);

      const seen = new Set<string>();
      return [...recent, ...topRated]
        .filter((item) => {
          if (seen.has(item.Id)) {
            return false;
          }
          seen.add(item.Id);
          return true;
        })
        .map((item) => {
          const tmdbId = Number(
            item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb
          );
          return {
            name: item.Name,
            type: item.Type === 'Movie' ? 'movie' : 'tv',
            year: item.ProductionYear,
            tmdbId: tmdbId > 0 ? tmdbId : undefined,
            genres: item.Genres ?? [],
            runtimeMinutes: item.RunTimeTicks
              ? Math.round(item.RunTimeTicks / 600_000_000)
              : undefined,
            rating: item.CommunityRating,
          };
        });
    } catch (e) {
      logger.error(
        `Something went wrong while getting unwatched items from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  // Lists items as seen by one user (so played/favorite filters apply to
  // them). Jellyfin 10.9+ takes userId as a query param; Emby still uses
  // /Users/{id}/Items.
  private getUserItems(
    userId: string,
    params: Record<string, string | number>
  ) {
    return this.mediaServerType === MediaServerType.JELLYFIN
      ? this.get<{ Items: JellyfinUserItem[] }>('/Items', {
          params: { ...params, userId },
        })
      : this.get<{ Items: JellyfinUserItem[] }>(`/Users/${userId}/Items`, {
          params,
        });
  }

  // Runs the query once per library when limited to some libraries, then
  // merges the results, highest `sortKey` first.
  private async queryUserItems(
    userId: string,
    params: Record<string, string | number>,
    libraryIds: string[] | undefined,
    sortKey: (item: JellyfinUserItem) => string
  ): Promise<JellyfinUserItem[]> {
    if (!libraryIds) {
      return (await this.getUserItems(userId, params)).Items;
    }

    const perLibrary = await Promise.all(
      libraryIds.map((ParentId) =>
        this.getUserItems(userId, {
          ...params,
          ParentId,
          EnableUserData: 'true',
        })
      )
    );

    return perLibrary
      .flatMap((response) => response.Items)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
      .slice(0, Number(params.Limit));
  }

  public async getItemData(
    id: string
  ): Promise<JellyfinLibraryItemExtended | undefined> {
    try {
      const itemResponse = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          ids: id,
          fields: 'ProviderIds,MediaSources,Width,Height,IsHD,DateCreated',
        },
      });

      return itemResponse.Items?.[0];
    } catch (e) {
      if (availabilitySync.running) {
        if (e.response?.status === 500) {
          return undefined;
        }
      }

      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );
      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getSeasons(seriesID: string): Promise<JellyfinLibraryItem[]> {
    try {
      const seasonResponse = await this.get<any>(`/Shows/${seriesID}/Seasons`);

      return seasonResponse.Items;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of seasons from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getEpisodes<
    T extends { includeMediaInfo?: boolean } | undefined = undefined,
  >(
    seriesID: string,
    seasonID: string,
    options?: T
  ): Promise<EpisodeReturn<T>> {
    try {
      const episodeResponse = await this.get<any>(
        `/Shows/${seriesID}/Episodes`,
        {
          params: {
            seasonId: seasonID,
            ...(options?.includeMediaInfo && { fields: 'MediaSources' }),
          },
        }
      );

      return episodeResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async createApiToken(appName: string): Promise<string> {
    try {
      await this.post(`/Auth/Keys?App=${appName}`);
      const apiKeys = await this.get<any>(`/Auth/Keys`);
      return apiKeys.Items.reverse().find(
        (item: any) => item.AppName === appName
      ).AccessToken;
    } catch (e) {
      logger.error(
        `Something went wrong while creating an API key from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.InvalidAuthToken);
    }
  }
}

export default JellyfinAPI;

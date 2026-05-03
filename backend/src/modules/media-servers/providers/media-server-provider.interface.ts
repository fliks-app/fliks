export interface MediaServerProvider {
  readonly type: string;
  readonly label: string;
  readonly supportedEvents: string[];

  refreshLibrary(url: string, apiKey: string, path?: string): Promise<void>;
  testConnection(
    url: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }>;
}

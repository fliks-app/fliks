import { IsString, IsUrl } from 'class-validator';

export class ImportApiDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @IsString()
  apiKey: string;
}

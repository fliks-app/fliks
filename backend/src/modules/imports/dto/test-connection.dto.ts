import { IsNotEmpty, IsString } from 'class-validator';

export class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsNotEmpty()
  apiKey: string;
}

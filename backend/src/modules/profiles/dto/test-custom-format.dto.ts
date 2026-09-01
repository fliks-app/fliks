import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class TestCustomFormatDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  /** Torrent flags aren't in the title, so a `release_flag` condition can only
   *  be exercised if the tester says what the release would carry. */
  @IsBoolean()
  @IsOptional()
  freeleech?: boolean;

  @IsNumber()
  @IsOptional()
  downloadVolumeFactor?: number;
}

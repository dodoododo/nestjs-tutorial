import { ApiProperty } from '@nestjs/swagger';

export class ProfileDto {
  @ApiProperty({ example: 'jacob' })
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  bio!: string | null;

  @ApiProperty({ type: String, nullable: true })
  image!: string | null;

  @ApiProperty({ description: 'Whether the current user follows this profile' })
  following!: boolean;
}

export class ProfileResponseDto {
  @ApiProperty({ type: ProfileDto })
  profile!: ProfileDto;
}

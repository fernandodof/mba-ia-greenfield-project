import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { SignedUploadPartsDto } from './dto/signed-upload-parts.dto';
import { UploadedPartsDto } from './dto/uploaded-parts.dto';
import { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import { VideoDto } from './dto/video.dto';
import { VideosService } from './videos.service';

// The global ThrottlerGuard is meant for auth routes only (phase-02-auth/TD-08).
@ApiTags('videos')
@Controller('videos')
@SkipThrottle()
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Creates the video as a draft in the caller's channel and opens a multipart upload session in object storage. Use the returned part size/count to request presigned part URLs.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload session opened',
    type: VideoUploadSessionDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoUploadSessionDto> {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get an owned video',
    description:
      "Returns the lifecycle state and metadata of a video owned by the caller's channel, in any status.",
  })
  @ApiResponse({ status: 200, description: 'Video found', type: VideoDto })
  @ApiResponse({
    status: 400,
    description: 'The id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoDto> {
    const video = await this.videosService.findOwnedById(user.sub, id);
    return VideoDto.fromEntity(video);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      "Returns short-lived (1 h) presigned URLs for the given part numbers of the caller's draft video. The client PUTs each part's bytes straight to object storage.",
  })
  @ApiResponse({
    status: 200,
    description: 'Part URLs signed',
    type: SignedUploadPartsDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR), or a part number is above the video part count (UPLOAD_PARTS_INVALID)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not a draft (VIDEO_UPLOAD_NOT_ACTIVE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsDto> {
    return this.videosService.signUploadParts(user.sub, id, dto.partNumbers);
  }

  @Get(':id/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      "Lists the parts already stored for the caller's draft video, so an interrupted upload can resume.",
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts listed',
    type: UploadedPartsDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is not a draft, or its storage upload no longer exists (VIDEO_UPLOAD_NOT_ACTIVE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsDto> {
    return this.videosService.listUploadedParts(user.sub, id);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      "Aborts the multipart upload of the caller's draft video, deletes any stored original and keeps the video as failed with reason UPLOAD_ABORTED.",
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 400,
    description: 'The id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is not a draft, or it stopped being one while aborting (VIDEO_UPLOAD_NOT_ACTIVE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
  type HttpRedirectResponse,
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
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { SignedUploadPartsDto } from './dto/signed-upload-parts.dto';
import { UploadedPartsDto } from './dto/uploaded-parts.dto';
import { VideoProcessingStartedDto } from './dto/video-processing-started.dto';
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

  @Get(':slug/stream')
  @Public()
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Public. Redirects to a short-lived (1 h) presigned URL of the original file; object storage answers Range requests with 206 Partial Content. Only ready videos are served.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned stream URL',
    headers: {
      Location: {
        description: 'Presigned GET URL of the original file (1 h TTL)',
        schema: { type: 'string', format: 'uri' },
      },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug, or the video is not ready (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('slug') slug: string): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getPlaybackUrl(slug, 'stream');
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':slug/download')
  @Public()
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Public. Redirects to a short-lived (1 h) presigned URL of the original file that storage serves as an attachment named after the video title plus the original extension. Only ready videos are served.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
    headers: {
      Location: {
        description:
          'Presigned GET URL of the original file (1 h TTL) with an attachment Content-Disposition override',
        schema: { type: 'string', format: 'uri' },
      },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug, or the video is not ready (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getPlaybackUrl(slug, 'download');
    return { url, statusCode: HttpStatus.FOUND };
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

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      "Completes the multipart upload of the caller's draft video, checks the stored size, moves the video to processing and enqueues its processing job. Idempotent: repeating the call on a processing video returns the same response.",
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing started',
    type: VideoProcessingStartedDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR), or the parts are not exactly the video parts in ascending order or were rejected by storage (UPLOAD_PARTS_INVALID; the video stays a draft)',
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
      'The video is ready or failed, or its storage upload is gone with nothing stored (VIDEO_UPLOAD_NOT_ACTIVE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'The stored size differs from the declared size; the object is deleted and the video fails (UPLOAD_SIZE_MISMATCH)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoProcessingStartedDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
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

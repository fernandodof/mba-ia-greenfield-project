// TD-05: one private bucket, every object of a video under `videos/{id}/`.

export function originalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}

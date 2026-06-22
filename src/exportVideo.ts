import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  type VideoSample
} from 'mediabunny';
import type { AssetRecord, ProjectRecord, TimelineItem } from './types';

type ExportOptions = {
  onProgress(progress: number): void;
};

type VideoClipReader = {
  iterator: AsyncGenerator<VideoSample | null, void, unknown>;
};

function trackIndex(project: ProjectRecord, clip: TimelineItem) {
  const index = project.tracks.findIndex((track) => track.id === clip.trackId);
  return index < 0 ? project.tracks.length : index;
}

function isTrackMuted(project: ProjectRecord, clip: TimelineItem) {
  return !!project.tracks.find((track) => track.id === clip.trackId)?.muted;
}

function drawMedia(
  context: CanvasRenderingContext2D,
  project: ProjectRecord,
  clip: TimelineItem,
  sourceWidth: number,
  sourceHeight: number,
  draw: (x: number, y: number, width: number, height: number) => void
) {
  const projectRatio = project.width / project.height;
  const sourceRatio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : projectRatio;
  const width = sourceRatio >= projectRatio ? project.width : project.height * sourceRatio;
  const height = sourceRatio >= projectRatio ? project.width / sourceRatio : project.height;
  context.save();
  context.globalAlpha = clip.transform.opacity / 100;
  context.translate(
    project.width * (0.5 + clip.transform.x / 100),
    project.height * (0.5 + clip.transform.y / 100)
  );
  context.rotate((clip.transform.rotation * Math.PI) / 180);
  context.scale(clip.transform.scale, clip.transform.scale);
  draw(-width / 2, -height / 2, width, height);
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, project: ProjectRecord, clip: TimelineItem) {
  const fontSize = Math.max(28, Math.min(72, project.width * 0.038));
  context.save();
  context.globalAlpha = clip.transform.opacity / 100;
  context.translate(
    project.width * (0.5 + clip.transform.x / 100),
    project.height * (0.5 + clip.transform.y / 100)
  );
  context.rotate((clip.transform.rotation * Math.PI) / 180);
  context.scale(clip.transform.scale, clip.transform.scale);
  context.fillStyle = '#ffffff';
  context.font = `800 ${fontSize}px "DM Sans", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0, 0, 0, 0.65)';
  context.shadowBlur = 18;
  context.shadowOffsetY = 3;
  context.fillText(clip.text || '', 0, 0, project.width * 0.9);
  context.restore();
}

export async function renderProjectToMp4(project: ProjectRecord, options: ExportOptions): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(project.width / 2) * 2);
  canvas.height = Math.max(2, Math.round(project.height / 2) * 2);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('No se pudo iniciar el compositor de video.');

  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const blobCache = new Map<string, Promise<Blob>>();
  const inputCache = new Map<string, Input<BlobSource>>();
  const imageCache = new Map<string, ImageBitmap>();

  const getBlob = (asset: AssetRecord) => {
    let promise = blobCache.get(asset.id);
    if (!promise) {
      if (!asset.objectUrl) throw new Error(`No se puede cargar ${asset.name}.`);
      promise = fetch(asset.objectUrl).then((response) => {
        if (!response.ok) throw new Error(`No se puede leer ${asset.name}.`);
        return response.blob();
      });
      blobCache.set(asset.id, promise);
    }
    return promise;
  };

  const getInput = async (asset: AssetRecord) => {
    let input = inputCache.get(asset.id);
    if (!input) {
      input = new Input({ source: new BlobSource(await getBlob(asset)), formats: ALL_FORMATS });
      inputCache.set(asset.id, input);
    }
    return input;
  };

  const visualClips = project.timeline.filter((clip) => clip.type === 'video' || clip.type === 'image' || clip.type === 'text');
  const imageAssets = visualClips
    .filter((clip) => clip.type === 'image' && clip.assetId)
    .map((clip) => assetById.get(clip.assetId!))
    .filter((asset): asset is AssetRecord => !!asset);
  for (const asset of new Map(imageAssets.map((asset) => [asset.id, asset])).values()) {
    imageCache.set(asset.id, await createImageBitmap(await getBlob(asset)));
  }

  options.onProgress(3);
  const sampleRate = 48_000;
  const offlineAudio = new OfflineAudioContext(2, Math.max(1, Math.ceil(project.duration * sampleRate)), sampleRate);
  let hasAudio = false;
  for (const clip of project.timeline.filter((item) => (item.type === 'audio' || item.type === 'video') && !isTrackMuted(project, item))) {
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
    if (!asset) continue;
    const input = await getInput(asset);
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack || !(await audioTrack.canDecode())) continue;
    const sink = new AudioBufferSink(audioTrack);
    const trimStart = clip.trimStart || 0;
    const trimEnd = trimStart + clip.duration;
    for await (const wrapped of sink.buffers(trimStart, trimEnd)) {
      const sourceStart = Math.max(trimStart, wrapped.timestamp);
      const sourceEnd = Math.min(trimEnd, wrapped.timestamp + wrapped.duration);
      const offset = Math.max(0, sourceStart - wrapped.timestamp);
      const duration = Math.min(sourceEnd - sourceStart, wrapped.buffer.duration - offset);
      if (duration <= 0) continue;
      const node = offlineAudio.createBufferSource();
      node.buffer = wrapped.buffer;
      node.connect(offlineAudio.destination);
      node.start(clip.start + sourceStart - trimStart, offset, duration);
      hasAudio = true;
    }
  }
  const mixedAudio = hasAudio ? await offlineAudio.startRendering() : null;
  options.onProgress(8);

  const fps = Math.max(1, project.fps);
  const frameDuration = 1 / fps;
  const frameCount = Math.max(1, Math.ceil(project.duration * fps));
  const videoReaders = new Map<string, VideoClipReader>();
  for (const clip of visualClips.filter((item) => item.type === 'video')) {
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
    if (!asset) continue;
    const input = await getInput(asset);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) continue;
    const timestamps: number[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = frame * frameDuration;
      if (time >= clip.start && time < clip.start + clip.duration) {
        timestamps.push(time - clip.start + (clip.trimStart || 0));
      }
    }
    videoReaders.set(clip.id, {
      iterator: new VideoSampleSink(videoTrack).samplesAtTimestamps(timestamps)
    });
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,
    keyFrameInterval: 2
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = mixedAudio ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const orderedVisualClips = [...visualClips].sort((a, b) => trackIndex(project, b) - trackIndex(project, a));
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame * frameDuration;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    for (const clip of orderedVisualClips) {
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      if (clip.type === 'text') {
        drawText(context, project, clip);
        continue;
      }
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
      if (!asset) continue;
      if (clip.type === 'image') {
        const image = imageCache.get(asset.id);
        if (image) drawMedia(context, project, clip, image.width, image.height, (x, y, width, height) => context.drawImage(image, x, y, width, height));
        continue;
      }
      const reader = videoReaders.get(clip.id);
      if (!reader) continue;
      const result = await reader.iterator.next();
      const sample = result.value;
      if (!sample) continue;
      drawMedia(context, project, clip, sample.displayWidth, sample.displayHeight, (x, y, width, height) => sample.draw(context, x, y, width, height));
      sample.close();
    }

    await videoSource.add(time, frameDuration, { keyFrame: frame % Math.max(1, fps * 2) === 0 });
    options.onProgress(8 + Math.round(((frame + 1) / frameCount) * 87));
  }

  if (audioSource && mixedAudio) await audioSource.add(mixedAudio);
  await output.finalize();
  options.onProgress(100);

  imageCache.forEach((image) => image.close());
  inputCache.forEach((input) => input.dispose());
  if (!target.buffer) throw new Error('No se pudo crear el archivo MP4.');
  return new Blob([target.buffer], { type: 'video/mp4' });
}

import { Innertube, Platform } from "youtubei.js/web";
import { getClientVisitorData } from "@/shared/api/visitorSession";
import { InnertubeError } from "./innertubeClient";
import { selectBestAudioFormat, toResolvedStream, type AudioFormat, type ResolvedAudioStream } from "./innertubeAudioFormats";
import { mintContentPoToken, resetPoTokenMinter } from "./poTokenMinter";

interface WebRemixSession {
  visitorData: string;
  innertube: Innertube;
}

let sessionPromise: Promise<WebRemixSession> | null = null;
let evaluatorInstalled = false;

function installPlayerEvaluator(): void {
  if (evaluatorInstalled) return;
  Platform.shim.eval = async (data, env) => {
    const args = [env.n, env.sp, env.sig].map((value) => JSON.stringify(value ?? ""));
    return new Function(`${data.output}\nreturn process(${args.join(", ")});`)();
  };
  evaluatorInstalled = true;
}

async function createSession(visitorData: string): Promise<WebRemixSession> {
  const innertube = await Innertube.create({
    visitor_data: visitorData,
    user_agent: navigator.userAgent,
    generate_session_locally: true,
    retrieve_player: true,
    fetch: (input, init) => fetch(input, init),
  });
  return { visitorData, innertube };
}

async function getSession(): Promise<WebRemixSession> {
  const visitorData = await getClientVisitorData();
  const existing = sessionPromise ? await sessionPromise.catch(() => null) : null;
  if (existing && existing.visitorData === visitorData) return existing;
  sessionPromise = createSession(visitorData);
  sessionPromise.catch(() => {
    sessionPromise = null;
  });
  return sessionPromise;
}

export function resetWebRemixSession(): void {
  sessionPromise = null;
  resetPoTokenMinter();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function resolveWebRemixAudioStream(
  videoId: string,
  options: { signal?: AbortSignal; preferredCodec?: "opus" | "aac" } = {},
): Promise<ResolvedAudioStream> {
  installPlayerEvaluator();
  const { innertube, visitorData } = await getSession();
  throwIfAborted(options.signal);

  const poToken = await mintContentPoToken(innertube, visitorData, videoId);
  throwIfAborted(options.signal);
  const info = await innertube.getBasicInfo(videoId, { client: "YTMUSIC", po_token: poToken });
  throwIfAborted(options.signal);
  const status = info.playability_status?.status;
  if (status !== "OK") throw new InnertubeError(info.playability_status?.reason || `WEB_REMIX: ${status}`, 403);

  const audioFormats = (info.streaming_data?.adaptive_formats ?? []).filter(
    (format) => format.has_audio && !format.has_video && format.mime_type.startsWith("audio/"),
  );
  const candidates: AudioFormat[] = audioFormats.map((format) => ({
    itag: format.itag,
    url: "",
    mimeType: format.mime_type,
    bitrate: format.bitrate || format.average_bitrate || 0,
    ...(Number(format.content_length) > 0 ? { contentLength: Number(format.content_length) } : {}),
  }));
  const best = selectBestAudioFormat(candidates, options.preferredCodec);
  const source = best ? audioFormats.find((format) => format.itag === best.itag) : undefined;
  if (!best || !source) throw new InnertubeError("WEB_REMIX returned no audio formats.", 502);

  const deciphered = await source.decipher(innertube.session.player);
  throwIfAborted(options.signal);
  const url = new URL(deciphered);
  url.searchParams.set("pot", poToken);
  return toResolvedStream({ ...best, url: url.toString() });
}

import type { TrackArtist as ContractTrackArtist } from "../contracts";

export interface TrackArtist {
  id?: string;
  name: string;
}

export interface Track {
  id: string;
  playlistItemId?: string;
  /** When the track was added to its playlist (ISO timestamp); drives "recently added" sorting. */
  playlistAddedAt?: string;
  title: string;
  artists: string;
  artistId?: string;
  artistList?: (ContractTrackArtist | TrackArtist)[];
  coverUrl: string;
  durationMs: number;
  playCount: number;
  explicit?: boolean;
  releaseDate?: string;
  album?: {
    id: string;
    title: string;
  };
}

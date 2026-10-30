import { useEffect, useState } from "react";
import Button from "@/shared/ui/Button";
import Dialog from "@/shared/ui/Dialog";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { useTranslation } from "@/languages";
import { api, getAuthSession } from "@/shared/api";
import {
  createSharedPlaylist,
  getSharedPlaylist,
  invitePlaylistCollaborator,
  removePlaylistCollaborator,
  type SharedPlaylist,
} from "../../services/sharedPlaylists";

interface PlaylistCollaboratorsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlistId: string;
  isShared: boolean;
}

export default function PlaylistCollaboratorsDialog({
  open,
  onOpenChange,
  playlistId,
  isShared,
}: PlaylistCollaboratorsDialogProps) {
  const { t } = useTranslation();
  const [shared, setShared] = useState<SharedPlaylist | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.searchUsers>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentUserId = getAuthSession()?.user.id;

  useEffect(() => {
    if (!open || !isShared) return;
    let active = true;
    setLoading(true);
    void getSharedPlaylist(playlistId)
      .then((playlist) => {
        if (active) setShared(playlist);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isShared, open, playlistId]);

  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api.searchUsers(term)
        .then((users) => {
          if (active) setResults(users.filter((user) => user.id !== currentUserId));
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [currentUserId, open, query]);

  const ensureShared = async (): Promise<SharedPlaylist> => {
    if (shared) return shared;
    setLoading(true);
    setError("");
    try {
      const playlist = await createSharedPlaylist(playlistId);
      setShared(playlist);
      window.dispatchEvent(new Event("library:changed"));
      return playlist;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      throw reason;
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async (userId: string) => {
    setLoading(true);
    setError("");
    try {
      const playlist = await ensureShared();
      const updated = await invitePlaylistCollaborator(playlist.id, userId);
      setShared(updated);
      setQuery("");
      setResults([]);
      window.dispatchEvent(new Event("library:changed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!shared) return;
    setLoading(true);
    setError("");
    try {
      await removePlaylistCollaborator(shared.id, userId);
      setShared(await getSharedPlaylist(shared.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const owner = shared?.role === "owner";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth={440}
      maxHeight="min(80vh, 640px)"
      className="p-[20px]"
    >
      <div className="flex flex-col gap-[16px]">
        <div className="flex flex-col gap-[4px]">
          <h2 className="m-0 text-[18px] font-[600] text-text-primary">
            {t("playlist.collaborators_title")}
          </h2>
          <p className="m-0 text-[13px] text-text-secondary">
            {t("playlist.collaborators_description")}
          </p>
        </div>

        {!isShared && !shared && (
          <Button
            variant="primary"
            disabled={loading}
            onClick={() => void ensureShared()}
            className="w-full"
          >
            {t("playlist.collaborators_create")}
          </Button>
        )}

        {(isShared || shared) && (
          <>
            {owner && (
              <label className="flex flex-col gap-[7px] text-[12px] text-text-secondary">
                {t("playlist.collaborators_search")}
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("playlist.collaborators_search_placeholder")}
                  className="h-[38px] rounded-lg border border-border-primary bg-bg-primary px-[10px] text-[13px] text-text-primary outline-none"
                />
              </label>
            )}

            {results.length > 0 && (
              <div className="flex max-h-[180px] flex-col gap-[4px] overflow-y-auto">
                {results.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-[9px] rounded-lg px-[8px] py-[6px] hover:bg-border-alpha-14"
                  >
                    <UserAvatar user={user} size={30} className="!rounded-full" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                      {user.displayName || user.username || user.id}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loading}
                      onClick={() => void handleInvite(user.id)}
                    >
                      {t("playlist.collaborators_add")}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-[6px]">
              {(shared?.members ?? []).map((member) => (
                <div
                  key={member.id}
                  className="flex items-center gap-[9px] rounded-lg bg-bg-primary px-[8px] py-[7px]"
                >
                  <UserAvatar
                    user={{
                      displayName: member.displayName,
                      username: member.username,
                      avatarUrl: member.avatarUrl,
                    }}
                    size={30}
                    className="!rounded-full"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                    {member.displayName || member.username || member.id}
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    {t(`playlist.collaborator_role_${member.role}`)}
                  </span>
                  {owner && member.id !== currentUserId && (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void handleRemove(member.id)}
                      className="border-0 bg-transparent p-[4px] text-[12px] text-text-tertiary hover:text-text-primary disabled:opacity-50"
                    >
                      {t("playlist.collaborators_remove")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="m-0 break-words text-[12px] text-accent-primary">
            {error}
          </p>
        )}

        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {t("common.close")}
        </Button>
      </div>
    </Dialog>
  );
}

import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AddSongToPlaylistBody,
  AddSongToPlaylistParams,
  AddSongToPlaylistResponse,
  CreatePlaylistBody,
  CreatePlaylistResponse,
  CreateSongBody,
  CreateSongResponse,
  DeletePlaylistParams,
  DeleteSongParams,
  FavoriteInput,
  GetDashboardResponse,
  GetPlaybackStateResponse,
  ImportExternalTrackBody,
  ListLibraryQueryParams,
  ListLibraryResponse,
  ListPlaylistsResponse,
  PlaylistSongInput,
  RemoveSongFromPlaylistParams,
  RemoveSongFromPlaylistResponse,
  ReorderPlaylistBody,
  ReorderPlaylistParams,
  ReorderPlaylistResponse,
  ToggleSongFavoriteBody,
  ToggleSongFavoriteParams,
  ToggleSongFavoriteResponse,
  UpdatePlaylistBody,
  UpdatePlaylistParams,
  UpdatePlaylistResponse,
  UpdatePlaybackStateBody,
  UpdatePlaybackStateResponse,
  UpdateSongBody,
  UpdateSongParams,
  UpdateSongResponse,
} from "@workspace/api-zod";
import {
  db,
  playbackStateTable,
  playlistSongsTable,
  playlistsTable,
  songsTable,
} from "@workspace/db";
import { and as drizzleAnd } from "drizzle-orm";

const router: IRouter = Router();

function songDto(song: typeof songsTable.$inferSelect) {
  return {
    ...song,
    durationSeconds: Number(song.durationSeconds),
    lastPlayedAt: song.lastPlayedAt ?? null,
    album: song.album ?? null,
    coverUrl: song.coverUrl ?? null,
    audioUrl: song.audioUrl ?? null,
  };
}

async function playlistDto(playlist: typeof playlistsTable.$inferSelect) {
  const rows = await db
    .select({
      songId: playlistSongsTable.songId,
      durationSeconds: songsTable.durationSeconds,
    })
    .from(playlistSongsTable)
    .innerJoin(songsTable, eq(playlistSongsTable.songId, songsTable.id))
    .where(eq(playlistSongsTable.playlistId, playlist.id))
    .orderBy(asc(playlistSongsTable.position));

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description ?? null,
    coverUrl: playlist.coverUrl ?? null,
    songIds: rows.map((row) => row.songId),
    songCount: rows.length,
    totalDurationSeconds: rows.reduce(
      (total, row) => total + Number(row.durationSeconds),
      0,
    ),
    createdAt: playlist.createdAt,
  };
}

async function getOrCreatePlaybackState() {
  const [existing] = await db
    .select()
    .from(playbackStateTable)
    .where(eq(playbackStateTable.id, 1));
  if (existing) return existing;

  const [created] = await db
    .insert(playbackStateTable)
    .values({
      id: 1,
      progressSeconds: "0",
      volume: "0.78",
      isShuffle: false,
      repeatMode: "off",
      queueSongIds: [],
      currentSongId: null,
      lastPlaylistId: null,
    })
    .returning();
  return created;
}

function playbackDto(state: typeof playbackStateTable.$inferSelect) {
  return {
    currentSongId: state.currentSongId ?? null,
    progressSeconds: Number(state.progressSeconds),
    volume: Number(state.volume),
    isShuffle: state.isShuffle,
    repeatMode: state.repeatMode,
    queueSongIds: state.queueSongIds ?? [],
    lastPlaylistId: state.lastPlaylistId ?? null,
  };
}

router.get("/library", async (req, res): Promise<void> => {
  const parsed = ListLibraryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const search = parsed.data.search?.trim();
  const songs = await db
    .select()
    .from(songsTable)
    .where(
      search
        ? or(
            ilike(songsTable.title, `%${search}%`),
            ilike(songsTable.artist, `%${search}%`),
            ilike(songsTable.album, `%${search}%`),
          )
        : undefined,
    )
    .orderBy(desc(songsTable.createdAt));

  res.json(ListLibraryResponse.parse(songs.map(songDto)));
});

router.post("/library", async (req, res): Promise<void> => {
  const parsed = CreateSongBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [song] = await db
    .insert(songsTable)
    .values({
      id: crypto.randomUUID(),
      ...parsed.data,
      durationSeconds: String(parsed.data.durationSeconds),
      album: parsed.data.album ?? null,
      coverUrl: parsed.data.coverUrl ?? null,
      audioUrl: parsed.data.audioUrl ?? null,
    })
    .returning();

  res.status(201).json(CreateSongResponse.parse(songDto(song)));
});

router.patch("/library/:songId", async (req, res): Promise<void> => {
  const params = UpdateSongParams.safeParse(req.params);
  const parsed = UpdateSongBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid song update" });
    return;
  }

  const [song] = await db
    .update(songsTable)
    .set({
      ...parsed.data,
      album: parsed.data.album ?? null,
      coverUrl: parsed.data.coverUrl ?? null,
    })
    .where(eq(songsTable.id, params.data.songId))
    .returning();
  if (!song) {
    res.status(404).json({ error: "Song not found" });
    return;
  }

  res.json(UpdateSongResponse.parse(songDto(song)));
});

router.delete("/library/:songId", async (req, res): Promise<void> => {
  const params = DeleteSongParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [song] = await db
    .delete(songsTable)
    .where(eq(songsTable.id, params.data.songId))
    .returning();
  if (!song) {
    res.status(404).json({ error: "Song not found" });
    return;
  }
  res.sendStatus(204);
});

router.patch(
  "/library/:songId/favorite",
  async (req, res): Promise<void> => {
    const params = ToggleSongFavoriteParams.safeParse(req.params);
    const parsed = ToggleSongFavoriteBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid favorite update" });
      return;
    }
    const [song] = await db
      .update(songsTable)
      .set({ isFavorite: parsed.data.isFavorite })
      .where(eq(songsTable.id, params.data.songId))
      .returning();
    if (!song) {
      res.status(404).json({ error: "Song not found" });
      return;
    }
    res.json(ToggleSongFavoriteResponse.parse(songDto(song)));
  },
);

router.get("/playlists", async (_req, res): Promise<void> => {
  const playlists = await db
    .select()
    .from(playlistsTable)
    .orderBy(desc(playlistsTable.createdAt));
  res.json(
    ListPlaylistsResponse.parse(await Promise.all(playlists.map(playlistDto))),
  );
});

router.post("/playlists", async (req, res): Promise<void> => {
  const parsed = CreatePlaylistBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [playlist] = await db
    .insert(playlistsTable)
    .values({
      id: crypto.randomUUID(),
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      coverUrl: parsed.data.coverUrl ?? null,
    })
    .returning();
  res
    .status(201)
    .json(CreatePlaylistResponse.parse(await playlistDto(playlist)));
});

router.patch("/playlists/:playlistId", async (req, res): Promise<void> => {
  const params = UpdatePlaylistParams.safeParse(req.params);
  const parsed = UpdatePlaylistBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid playlist update" });
    return;
  }
  const [playlist] = await db
    .update(playlistsTable)
    .set({
      ...parsed.data,
      description: parsed.data.description ?? null,
      coverUrl: parsed.data.coverUrl ?? null,
    })
    .where(eq(playlistsTable.id, params.data.playlistId))
    .returning();
  if (!playlist) {
    res.status(404).json({ error: "Playlist not found" });
    return;
  }
  res.json(
    UpdatePlaylistResponse.parse(await playlistDto(playlist)),
  );
});

router.delete("/playlists/:playlistId", async (req, res): Promise<void> => {
  const params = DeletePlaylistParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [playlist] = await db
    .delete(playlistsTable)
    .where(eq(playlistsTable.id, params.data.playlistId))
    .returning();
  if (!playlist) {
    res.status(404).json({ error: "Playlist not found" });
    return;
  }
  res.sendStatus(204);
});

router.post(
  "/playlists/:playlistId/songs",
  async (req, res): Promise<void> => {
    const params = AddSongToPlaylistParams.safeParse(req.params);
    const parsed = AddSongToPlaylistBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid playlist song" });
      return;
    }
    const [playlist] = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.id, params.data.playlistId));
    const [song] = await db
      .select()
      .from(songsTable)
      .where(eq(songsTable.id, parsed.data.songId));
    if (!playlist || !song) {
      res.status(404).json({ error: "Playlist or song not found" });
      return;
    }
    const existing = await db
      .select()
      .from(playlistSongsTable)
      .where(
        and(
          eq(playlistSongsTable.playlistId, playlist.id),
          eq(playlistSongsTable.songId, song.id),
        ),
      );
    if (existing.length === 0) {
      const current = await db
        .select()
        .from(playlistSongsTable)
        .where(eq(playlistSongsTable.playlistId, playlist.id));
      await db.insert(playlistSongsTable).values({
        playlistId: playlist.id,
        songId: song.id,
        position: current.length,
      });
    }
    res.json(
      AddSongToPlaylistResponse.parse(await playlistDto(playlist)),
    );
  },
);

router.delete(
  "/playlists/:playlistId/songs/:songId",
  async (req, res): Promise<void> => {
    const params = RemoveSongFromPlaylistParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [playlist] = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.id, params.data.playlistId));
    if (!playlist) {
      res.status(404).json({ error: "Playlist not found" });
      return;
    }
    await db
      .delete(playlistSongsTable)
      .where(
        and(
          eq(playlistSongsTable.playlistId, params.data.playlistId),
          eq(playlistSongsTable.songId, params.data.songId),
        ),
      );
    res.json(
      RemoveSongFromPlaylistResponse.parse(await playlistDto(playlist)),
    );
  },
);

router.patch(
  "/playlists/:playlistId/reorder",
  async (req, res): Promise<void> => {
    const params = ReorderPlaylistParams.safeParse(req.params);
    const parsed = ReorderPlaylistBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid playlist order" });
      return;
    }
    const [playlist] = await db
      .select()
      .from(playlistsTable)
      .where(eq(playlistsTable.id, params.data.playlistId));
    if (!playlist) {
      res.status(404).json({ error: "Playlist not found" });
      return;
    }
    await Promise.all(
      parsed.data.songIds.map((songId, position) =>
        db
          .update(playlistSongsTable)
          .set({ position })
          .where(
            and(
              eq(playlistSongsTable.playlistId, playlist.id),
              eq(playlistSongsTable.songId, songId),
            ),
          ),
      ),
    );
    res.json(
      ReorderPlaylistResponse.parse(await playlistDto(playlist)),
    );
  },
);

router.get("/dashboard", async (_req, res): Promise<void> => {
  const [songs, playlists, playback] = await Promise.all([
    db.select().from(songsTable).orderBy(desc(songsTable.createdAt)),
    db.select().from(playlistsTable).orderBy(desc(playlistsTable.createdAt)),
    getOrCreatePlaybackState(),
  ]);
  const currentSong = playback.currentSongId
    ? songs.find((song) => song.id === playback.currentSongId)
    : undefined;
  const data = {
    totalSongs: songs.length,
    totalPlaylists: playlists.length,
    favoriteSongs: songs.filter((song) => song.isFavorite).slice(0, 6).map(songDto),
    recentSongs: songs.slice(0, 6).map(songDto),
    recentPlaylists: await Promise.all(playlists.slice(0, 4).map(playlistDto)),
    continueListening: currentSong
      ? {
          song: songDto(currentSong),
          progressSeconds: Number(playback.progressSeconds),
        }
      : null,
  };
  res.json(GetDashboardResponse.parse(data));
});

router.get("/playback", async (_req, res): Promise<void> => {
  res.json(GetPlaybackStateResponse.parse(playbackDto(await getOrCreatePlaybackState())));
});

router.put("/playback", async (req, res): Promise<void> => {
  const parsed = UpdatePlaybackStateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [state] = await db
    .insert(playbackStateTable)
    .values({
      id: 1,
      currentSongId: parsed.data.currentSongId ?? null,
      progressSeconds: String(parsed.data.progressSeconds),
      volume: String(parsed.data.volume),
      isShuffle: parsed.data.isShuffle,
      repeatMode: parsed.data.repeatMode,
      queueSongIds: parsed.data.queueSongIds,
      lastPlaylistId: parsed.data.lastPlaylistId ?? null,
    })
    .onConflictDoUpdate({
      target: playbackStateTable.id,
      set: {
        currentSongId: parsed.data.currentSongId ?? null,
        progressSeconds: String(parsed.data.progressSeconds),
        volume: String(parsed.data.volume),
        isShuffle: parsed.data.isShuffle,
        repeatMode: parsed.data.repeatMode,
        queueSongIds: parsed.data.queueSongIds,
        lastPlaylistId: parsed.data.lastPlaylistId ?? null,
      },
    })
    .returning();
  res.json(UpdatePlaybackStateResponse.parse(playbackDto(state)));
});

router.post("/imports", async (req, res): Promise<void> => {
  const parsed = ImportExternalTrackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.status(422).json({
    error: `La importación de ${parsed.data.source} requiere configurar su API oficial. No se descargará ni extraerá contenido protegido.`,
  });
});

async function seedMusic() {
  const existing = await db.select({ id: songsTable.id }).from(songsTable).limit(1);
  if (existing.length > 0) return;
  const songs = [
    {
      id: crypto.randomUUID(),
      title: "Afterglow",
      artist: "Faricraft Sessions",
      album: "Night Signals",
      durationSeconds: "231",
      coverUrl: null,
      audioUrl: null,
      source: "local",
      sourceLabel: "Tu biblioteca",
      isFavorite: true,
      playCount: 12,
    },
    {
      id: crypto.randomUUID(),
      title: "Still Rooms",
      artist: "Mara Vale",
      album: "Soft Focus",
      durationSeconds: "198",
      coverUrl: null,
      audioUrl: null,
      source: "youtube_music",
      sourceLabel: "YouTube Music",
      isFavorite: false,
      playCount: 6,
    },
    {
      id: crypto.randomUUID(),
      title: "Blue Hour",
      artist: "Kaito North",
      album: "Low Tide",
      durationSeconds: "264",
      coverUrl: null,
      audioUrl: null,
      source: "spotify",
      sourceLabel: "Spotify",
      isFavorite: true,
      playCount: 4,
    },
  ];
  await db.insert(songsTable).values(songs);
  const playlistId = crypto.randomUUID();
  await db.insert(playlistsTable).values({
    id: playlistId,
    name: "Late night / soft light",
    description: "Una selección para bajar el ritmo.",
    coverUrl: null,
  });
  await db.insert(playlistSongsTable).values(
    songs.map((song, position) => ({
      playlistId,
      songId: song.id,
      position,
    })),
  );
  await getOrCreatePlaybackState();
}

export { seedMusic };
export default router;
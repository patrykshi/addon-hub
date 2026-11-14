import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreamHubConfig } from './config.ts';
import {
  computeTokenOverlap,
  isPtBrStream,
  normalizeTitle,
  processStreams,
  type RawAddonStream,
} from './matcher.ts';
import { parseRequestId } from './metadata.ts';

const baseConfig: StreamHubConfig = {
  addons: [{ url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio' }],
  resolutions: ['2160p', '1080p', '720p', '480p'],
  allowUnknownRes: true,
  languageMode: 'prioritize_ptbr',
  strictMetaMatch: true,
  timeoutMs: 6500,
  tmdbApiKey: '',
};

test('parseRequestId extracts cleanId, season, and episode', () => {
  assert.deepEqual(parseRequestId('tt0137523'), {
    rawId: 'tt0137523',
    cleanId: 'tt0137523',
    reqSeason: undefined,
    reqEpisode: undefined,
  });
  assert.deepEqual(parseRequestId('tt0903747%3A1%3A5.json'), {
    rawId: 'tt0903747:1:5',
    cleanId: 'tt0903747',
    reqSeason: 1,
    reqEpisode: 5,
  });
});

test('normalizeTitle removes accents and punctuation cleanly', () => {
  assert.equal(normalizeTitle('Ação & Reação: O Retorno!'), 'acao reacao o retorno');
  assert.ok(computeTokenOverlap('Clube da Luta', 'Clube da Luta Remastered') >= 0.6);
});

test('Movie Year Lock allows +/- 1 year tolerance and blocks > 1 year mismatch', () => {
  const streams: RawAddonStream[] = [
    {
      addonName: 'Torrentio',
      stream: {
        name: '[RD+] Torrentio\n1080p',
        title: 'Fight.Club.1999.1080p.BluRay.x264.mkv',
        infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    {
      addonName: 'Comet',
      stream: {
        name: 'Comet\n1080p',
        title: 'Fight.Club.2000.Festival.1080p.WEB-DL.mkv',
        infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n1080p',
        title: 'Fight.Club.2016.Wrong.Movie.1080p.WEB-DL.mkv',
        infoHash: 'cccccccccccccccccccccccccccccccccccccccc',
      },
    },
  ];

  const out = processStreams(streams, baseConfig, {
    type: 'movie',
    canonicalMeta: {
      imdbId: 'tt0137523',
      type: 'movie',
      canonicalTitles: ['Fight Club', 'Clube da Luta'],
      year: 1999,
      fetchedAt: Date.now(),
    },
  });

  assert.equal(out.length, 2);
  assert.equal(out[0].infoHash, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(out[1].infoHash, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('Series Season/Episode Lock rejects wrong season/episode and allows valid Season Pack', () => {
  const streams: RawAddonStream[] = [
    {
      addonName: 'Torrentio',
      stream: {
        name: '[RD+] Torrentio\n1080p',
        title: 'Breaking.Bad.S01E05.1080p.BluRay.mkv',
        infoHash: '1111111111111111111111111111111111111111',
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n1080p',
        title: 'Breaking.Bad.S02E05.1080p.BluRay.mkv',
        infoHash: '2222222222222222222222222222222222222222',
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n1080p',
        title: 'Breaking.Bad.S01E04.1080p.BluRay.mkv',
        infoHash: '3333333333333333333333333333333333333333',
      },
    },
    {
      addonName: 'Comet',
      stream: {
        name: 'Comet\n1080p',
        title: 'Breaking.Bad.S01.COMPLETE.1080p.BluRay',
        infoHash: '4444444444444444444444444444444444444444',
        fileIdx: 4,
      },
    },
  ];

  const out = processStreams(streams, baseConfig, {
    type: 'series',
    reqSeason: 1,
    reqEpisode: 5,
    canonicalMeta: {
      imdbId: 'tt0903747',
      type: 'series',
      canonicalTitles: ['Breaking Bad'],
      year: 2008,
      fetchedAt: Date.now(),
    },
  });

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((s) => s.infoHash),
    ['1111111111111111111111111111111111111111', '4444444444444444444444444444444444444444'],
  );
});

test('Title Sanity Check rejects unrelated titles and keeps clean direct HTTP links without release structure', () => {
  const streams: RawAddonStream[] = [
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n1080p',
        title: 'Totally.Different.Movie.1999.1080p.BluRay.mkv',
        infoHash: '5555555555555555555555555555555555555555',
      },
    },
    {
      addonName: 'NuvioStreams',
      stream: {
        name: 'NuvioStreams 1080p',
        title: 'Servidor Principal HD Dublado',
        url: 'https://cdn.example.com/stream/fight-club.mp4',
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: { Referer: 'https://cdn.example.com' },
          },
        },
      },
    },
  ];

  const out = processStreams(streams, baseConfig, {
    type: 'movie',
    canonicalMeta: {
      imdbId: 'tt0137523',
      type: 'movie',
      canonicalTitles: ['Fight Club', 'Clube da Luta'],
      year: 1999,
      fetchedAt: Date.now(),
    },
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example.com/stream/fight-club.mp4');
  assert.equal(out[0].name, '⚡ [NuvioStreams] | 1080p | 🇧🇷');
  assert.deepEqual(out[0].behaviorHints?.proxyHeaders, {
    request: { Referer: 'https://cdn.example.com' },
  });
});

test('Deduplication, PT-BR priority, Resolution sort, Debrid Cache tie-breaker, and behaviorHints preservation', () => {
  const streams: RawAddonStream[] = [
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n4k',
        title: 'Fight.Club.1999.2160p.UHD.BluRay.x265.mkv',
        infoHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        fileIdx: 0,
      },
    },
    {
      addonName: 'Comet',
      stream: {
        name: '[RD+] Comet\n4k',
        title: 'Fight.Club.1999.2160p.UHD.BluRay.x265.mkv',
        infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        fileIdx: 0,
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: 'Torrentio\n1080p',
        title: 'Fight.Club.1999.1080p.BluRay.x264.mkv',
        infoHash: '6666666666666666666666666666666666666666',
      },
    },
    {
      addonName: 'Comet',
      stream: {
        name: '[RD+] Comet\n1080p',
        title: 'Fight.Club.1999.1080p.BluRay.DUAL.PT-BR.mkv',
        infoHash: '7777777777777777777777777777777777777777',
        behaviorHints: { bingeGroup: 'comet-1080p' },
      },
    },
    {
      addonName: 'MediaFusion',
      stream: {
        name: '⚡ MediaFusion\n1080p',
        title: 'Clube.da.Luta.1999.1080p.BluRay.x264.mkv',
        infoHash: '8888888888888888888888888888888888888888',
      },
    },
  ];

  const out = processStreams(streams, baseConfig, {
    type: 'movie',
    canonicalMeta: {
      imdbId: 'tt0137523',
      type: 'movie',
      canonicalTitles: ['Fight Club', 'Clube da Luta'],
      year: 1999,
      fetchedAt: Date.now(),
    },
  });

  // Deduplicated from 5 to 4
  assert.equal(out.length, 4);
  // 1st: PT-BR stream on top
  assert.equal(out[0].name, '⚡ [Comet] | 1080p | 🇧🇷');
  assert.equal(out[0].behaviorHints?.bingeGroup, 'comet-1080p');
  // 2nd: 4K stream next
  assert.equal(out[1].name, '⚡ [Torrentio] | 4K');
  // 3rd: 1080p with debrid cache (⚡) beats non-cached 1080p
  assert.equal(out[2].name, '⚡ [MediaFusion] | 1080p');
  assert.equal(out[3].name, '⚡ [Torrentio] | 1080p');

  // only_ptbr mode filters out non-PT-BR streams
  const onlyPtBrOut = processStreams(
    streams,
    { ...baseConfig, languageMode: 'only_ptbr' },
    {
      type: 'movie',
      canonicalMeta: {
        imdbId: 'tt0137523',
        type: 'movie',
        canonicalTitles: ['Fight Club', 'Clube da Luta'],
        year: 1999,
        fetchedAt: Date.now(),
      },
    },
  );
  assert.equal(onlyPtBrOut.length, 1);
  assert.equal(isPtBrStream('Dual Áudio 🇧🇷'), true);
});

test('Direct HTTP streams (without infoHash) are never discarded by strictMetaMatch while infoHash torrents remain strictly checked', () => {
  const streams: RawAddonStream[] = [
    {
      addonName: 'Veyra',
      stream: {
        name: 'Veyra FHD',
        title: 'Player Principal - S01E05 (Dublado)',
        url: 'https://veyra.shardweb.app/stream/1.m3u8',
      },
    },
    {
      addonName: 'Brazuca Play',
      stream: {
        name: 'Brazuca Play\nHD',
        title: 'Servidor 2 - (2008) [PT-BR]',
        url: 'https://brazuca.example/play/2.mp4',
      },
    },
    {
      addonName: 'VêTela',
      stream: {
        name: 'VêTela',
        title: 'Player Alpha - Título Genérico (2024)',
        url: 'https://vetela.cc/stream/player-alpha.mp4',
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: '[RD+] Torrentio\n1080p',
        title: 'Breaking.Bad.S01E05.1080p.BluRay.x264.mkv',
        infoHash: '9999999999999999999999999999999999999999',
        behaviorHints: {
          filename: 'Breaking.Bad.S01E05.1080p.BluRay.x264.mkv',
        },
      },
    },
    {
      addonName: 'Torrentio',
      stream: {
        name: '[RD+] Torrentio\n1080p',
        title: 'Wrong.Series.S01E05.1080p.WEB-DL.x264.mkv',
        infoHash: '8888888888888888888888888888888888888888',
        behaviorHints: {
          filename: 'Wrong.Series.S01E05.1080p.WEB-DL.x264.mkv',
        },
      },
    },
  ];

  const out = processStreams(streams, baseConfig, {
    type: 'series',
    reqSeason: 1,
    reqEpisode: 5,
    canonicalMeta: {
      imdbId: 'tt0903747',
      type: 'series',
      canonicalTitles: ['Breaking Bad'],
      year: 2008,
      fetchedAt: Date.now(),
    },
  });

  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((s) => s.name),
    [
      '⚡ [Veyra] | 1080p | 🇧🇷',
      '⚡ [Brazuca Play] | 720p | 🇧🇷',
      '⚡ [Torrentio] | 1080p',
      '⚡ [VêTela] | Auto',
    ],
  );
});


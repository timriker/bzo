/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// ctfOverseer.cjs - allejo's ctfOverseer (github.com/allejo/ctfOverseer), which
// many CTF servers load, written again for bzo. Off until server.json's
// "plugins" turns it on; on, it does what allejo's does by default, and its
// two BZDB variables tune it from a world or `/set`:
//
// - `_disallowSelfCap`, 1: refuse a capture of the capper's own flag.
// - `_delayTeamFlagGrab`, 20: keep a team flag from enemy hands for that many
//   seconds after it was captured; its own team may still take it. The
//   refusal is said at most every five seconds, in the plugin's words.

'use strict';

const WARN_INTERVAL_MS = 5000;
// A team flag's abbreviation, by the bz_eTeamType it belongs to.
const TEAM_FLAGS = Object.freeze({ 'R*': 1, 'G*': 2, 'B*': 3, 'P*': 4 });
const TEAM_NAMES = Object.freeze({ 1: 'Red', 2: 'Green', 3: 'Blue', 4: 'Purple' });

module.exports = {
  meta: {
    name: 'ctfOverseer',
    version: '1.0',
    author: 'Tim Riker, after allejo',
    description: 'no capturing your own flag, and a wait before an enemy may grab a team flag just captured',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    this.cappedAt = new Map();
    this.warnedAt = new Map();
    bz.bz_registerCustomBZDBBool('_disallowSelfCap', true);
    bz.bz_registerCustomBZDBInt('_delayTeamFlagGrab', 20);
    bz.Register(bz.bz_eAllowCTFCaptureEvent);
    bz.Register(bz.bz_eCaptureEvent);
    bz.Register(bz.bz_eAllowFlagGrab);
    bz.Register(bz.bz_ePlayerPartEvent);
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_eAllowCTFCaptureEvent:
        if (data.teamCapped === data.teamCapping && bz.bz_getBZDBBool('_disallowSelfCap')) data.allow = false;
        break;
      case bz.bz_eCaptureEvent:
        this.cappedAt.set(data.teamCapped, Date.now());
        break;
      case bz.bz_eAllowFlagGrab:
        if (!this.grabAllowed(data.playerID, data.flagType)) data.allow = false;
        break;
      case bz.bz_ePlayerPartEvent:
        this.warnedAt.delete(data.playerID);
        break;
      default:
    }
  },

  grabAllowed(playerID, flagType) {
    const { bz } = this;
    const team = TEAM_FLAGS[flagType];
    const delay = bz.bz_getBZDBDouble('_delayTeamFlagGrab');
    if (team === undefined || !(delay > 0) || bz.bz_getPlayerTeam(playerID) === team) return true;
    const cappedAt = this.cappedAt.get(team);
    const now = Date.now();
    if (cappedAt === undefined || now >= cappedAt + (delay * 1000)) return true;
    if (now > (this.warnedAt.get(playerID) ?? -Infinity) + WARN_INTERVAL_MS) {
      this.warnedAt.set(playerID, now);
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
        'Team flags cannot be grabbed for {seconds} seconds after they were last capped.', { seconds: delay });
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
        'You cannot grab the {team} team flag for another ~{seconds} seconds', {
          team: { msgid: TEAM_NAMES[team] },
          seconds: Math.round((cappedAt + (delay * 1000) - now) / 1000),
        });
    }
    return false;
  },

  // Translations of what the plugin says, merged into what a bzo client is
  // sent while the plugin runs (docs/plugins-plan.md, "Translations").
  l10n: {
    cs_CZ: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Týmové vlajky nelze sebrat {seconds} s od posledního dobytí.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Vlajku týmu {team} nemůžeš sebrat ještě ~{seconds} s',
    },
    da: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Holdflag kan ikke tages i {seconds} sekunder efter sidste erobring.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Du kan ikke tage {team} holds flag før om ~{seconds} sekunder',
    },
    de: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Teamflaggen können {seconds} Sekunden nach der letzten Eroberung nicht aufgenommen werden.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Du kannst die Flagge von Team {team} erst in ~{seconds} Sekunden aufnehmen',
    },
    en_US_l33t: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        '734m fl4g5 c4nn07 b3 gr4bb3d f0r {seconds} 53c0nd5 4f73r 7h3y w3r3 l457 c4pp3d.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'j00 c4nn07 gr4b 73h {team} 734m fl4g f0r 4n07h3r ~{seconds} 53c0nd5',
    },
    en_US_redneck: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Team flags can\'t be grabbed fer {seconds} seconds after they last got capped.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Ya can\'t grab the {team} team flag fer \'nother ~{seconds} seconds',
    },
    es: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Las banderas de equipo no se pueden coger hasta {seconds} segundos después de su última captura.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'No puedes coger la bandera del equipo {team} durante unos ~{seconds} segundos más',
    },
    fr: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Les drapeaux d\'équipe ne peuvent pas être pris pendant {seconds} secondes après leur dernière capture.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Tu ne peux pas prendre le drapeau de l\'équipe {team} avant encore ~{seconds} secondes',
    },
    it: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Le bandiere di squadra non si possono prendere per {seconds} secondi dall\'ultima cattura.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Non puoi prendere la bandiera della squadra {team} per altri ~{seconds} secondi',
    },
    ja: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'チームフラグは最後にキャプチャーされてから{seconds}秒間取れません。',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'あと約{seconds}秒は{team}チームのフラグを取れません',
    },
    ko: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        '팀 플래그는 마지막 점령 후 {seconds}초 동안 잡을 수 없어요.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        '앞으로 약 {seconds}초 동안 {team} 팀 플래그를 잡을 수 없어요',
    },
    lt: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Komandų vėliavų negalima paimti {seconds} s nuo paskutinio užgrobimo.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Komandos {team} vėliavos negali paimti dar ~{seconds} s',
    },
    nl: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Teamvlaggen kunnen pas {seconds} seconden na de laatste verovering worden gepakt.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Je kunt de vlag van team {team} pas over ~{seconds} seconden pakken',
    },
    pt: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'As bandeiras de time não podem ser pegas durante {seconds} segundos após a última captura.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Você não pode pegar a bandeira do time {team} por mais ~{seconds} segundos',
    },
    pt_PT: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'As bandeiras de equipa não podem ser apanhadas durante {seconds} segundos após a última captura.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Não podes apanhar a bandeira da equipa {team} durante mais ~{seconds} segundos',
    },
    ru: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Командные флаги нельзя взять {seconds} с после последнего захвата.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Флаг команды {team} нельзя взять ещё ~{seconds} с',
    },
    sk: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Tímové vlajky sa nedajú zobrať {seconds} s od posledného dobytia.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Vlajku tímu {team} nemôžeš zobrať ešte ~{seconds} s',
    },
    sv: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'Lagflaggor kan inte tas förrän {seconds} sekunder efter senaste erövring.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'Du kan inte ta lag {team}s flagga förrän om ~{seconds} sekunder',
    },
    th: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'คว้าธงทีมไม่ได้เป็นเวลา {seconds} วินาทีหลังถูกยึดครั้งล่าสุด',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        'คุณคว้าธงทีม {team} ไม่ได้อีกประมาณ ~{seconds} วินาที',
    },
    tlh: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        'boq joqwI\' tlhaplu\'DI\', {seconds} lup tlhaplaHbe\'lu\'.',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        '{team} boq joqwI\' DatlhaplaHbe\'; ~{seconds} lup ret',
    },
    zh_CN: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        '队旗被夺取后 {seconds} 秒内不能拿取。',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        '还要约 {seconds} 秒才能拿取{team}队旗',
    },
    zh_TW: {
      'Team flags cannot be grabbed for {seconds} seconds after they were last capped.':
        '隊旗被奪取後 {seconds} 秒內不能拿取。',
      'You cannot grab the {team} team flag for another ~{seconds} seconds':
        '還要約 {seconds} 秒才能拿取{team}隊旗',
    },
  },
};

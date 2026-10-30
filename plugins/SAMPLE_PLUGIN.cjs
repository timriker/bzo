// SAMPLE_PLUGIN.cjs - upstream's plugins/SAMPLE_PLUGIN, the starting point for
// a new plugin. Copy it to data/plugins under a new name and fill it in;
// docs/plugins-plan.md says what a plugin is. Off unless server.json's
// "plugins" turns it on, as upstream ships it but loads it nowhere.
//
// Licensed under BSD so plug-ins can re-license as needed, as upstream's is.
/*
Copyright (c) 1993-2026 Tim Riker
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

'use strict';

module.exports = {
  meta: {
    name: 'SAMPLE PLUGIN',
    version: '1.0',
    author: 'Tim Riker',
    description: 'does nothing; a starting point for a new plugin',
    license: 'BSD-2-Clause',
    enabled: false,
  },

  Init(bz /* , config */) {
    bz.log('SAMPLE_PLUGIN plugin loaded');

    // init events here with bz.Register();
  },

  Event(/* eventData */) {},
};

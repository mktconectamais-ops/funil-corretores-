// api/lead.js
// Conecta+ — Funil Diagnóstico (versão simplificada)
// ─────────────────────────────────────────────────────────────
// Fluxo:
// 1. Recebe submissão do formulário.
// 2. Classifica por faixa de renda:
//    - >= R$20k/mês  → ICP   (tag "Funil Diagnóstico — ICP", tela "diagnóstico em 24h")
//    - <  R$20k/mês  → Não-ICP (tag diferente, tela "vamos avaliar")
// 3. Cria lead no Kommo com tag e nota simples. Diagnóstico será feito manualmente.
// 4. Devolve ao frontend o tipo do lead pra mostrar a tela certa.

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN     = process.env.KOMMO_TOKEN;

// A única faixa que NÃO é ICP. Tudo o mais é tratado como ICP.
const STR_NAO_ICP = 'abaixo de r$20k';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    // Vercel normalmente já parseia JSON, mas vamos ser defensivos
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const { nome, telefone, email, instagram, renda } = body || {};

    if (!nome || !telefone || !instagram || !renda) {
      return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
    }

    const isICP    = !ehNaoICP(renda);
    const username = limparUsername(instagram);
    const tag      = isICP ? 'Funil Diagnóstico — ICP' : 'Funil Diagnóstico — Não-ICP';
    const nota     = montarNota({ isICP, instagram, username, renda });

    const ok = await criarLeadNoKommo({ nome, telefone, email, tag, nota });

    if (!ok) {
      // Falha silenciosa é o pior cenário — devolvemos erro ao frontend
      return res.status(500).json({ error: 'Não foi possível registrar. Tente novamente.' });
    }

    return res.status(200).json({
      success: true,
      type: isICP ? 'icp' : 'nao_icp'
    });

  } catch (err) {
    console.error('Erro inesperado no handler:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ────────────────────────────── Helpers ──────────────────────────────

function ehNaoICP(renda) {
  return (renda || '').toLowerCase().trim() === STR_NAO_ICP;
}

function limparUsername(input) {
  if (!input) return '';
  return input
    .trim()
    .replace(/^@/, '')
    .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^a-zA-Z0-9._]/g, '');
}

function montarNota({ isICP, instagram, username, renda }) {
  const L = [];

  L.push('🎯 LEAD DO FUNIL DIAGNÓSTICO');
  L.push('═══════════════════════════');
  L.push('');
  L.push(`📱 Instagram: ${instagram} (@${username})`);
  L.push(`💰 Faixa de renda: ${renda}`);
  L.push(`🏷️ Classificação: ${isICP ? '✅ ICP (fazer diagnóstico)' : '⚠️ Fora do perfil ICP'}`);
  L.push('');

  if (isICP) {
    L.push('▶ PRÓXIMO PASSO');
    L.push('Analisar perfil @' + username + ' no Instagram,');
    L.push('preparar diagnóstico (manual / agente IA) e enviar via WhatsApp em até 24h.');
  } else {
    L.push('▶ PRÓXIMO PASSO');
    L.push('Lead fora do perfil de diagnóstico (renda < R$20k/mês).');
    L.push('Possível audiência para: mentoria, assessoria, captação e edição de conteúdo.');
  }

  return L.join('\n');
}

async function criarLeadNoKommo({ nome, telefone, email, tag, nota }) {
  const contatoFields = [{
    field_code: 'PHONE',
    values: [{ value: telefone, enum_code: 'WORK' }]
  }];

  if (email) {
    contatoFields.push({
      field_code: 'EMAIL',
      values: [{ value: email, enum_code: 'WORK' }]
    });
  }

  const payload = [{
    name: `[Diagnóstico] ${nome}`,
    _embedded: {
      tags:     [{ name: tag }],
      contacts: [{
        first_name:           nome,
        custom_fields_values: contatoFields
      }]
    }
  }];

  const respLead = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/complex`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${KOMMO_TOKEN}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  if (!respLead.ok) {
    console.error('Kommo erro ao criar lead:', await respLead.text());
    return false;
  }

  const dataLead = await respLead.json();
  const leadId   = dataLead[0]?.id;

  if (!leadId) {
    console.error('Kommo: lead criado mas sem ID retornado');
    return false;
  }

  const respNota = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${KOMMO_TOKEN}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify([{ note_type: 'common', params: { text: nota } }])
    }
  );

  if (!respNota.ok) {
    console.warn('Kommo: nota não anexada, mas lead foi criado.');
  }

  return true;
}

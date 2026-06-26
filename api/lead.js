// api/lead.js
// Conecta+ — Funil Diagnóstico (versão com roteamento automático de pipeline)
// ─────────────────────────────────────────────────────────────
// Fluxo:
// 1. Recebe submissão do formulário.
// 2. Classifica por faixa de renda:
//    - >= R$20k/mês → ICP   → Pipeline "Funil Diagnóstico — ICP", estágio "Base"
//    - <  R$20k/mês → Não-ICP → Pipeline "Não - ICP", estágio "Novo"
// 3. Cria lead no Kommo já no pipeline e estágio corretos.
// 4. Devolve ao frontend o tipo do lead pra mostrar a tela certa.

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN     = process.env.KOMMO_TOKEN;

// IDs extraídos da API do Kommo
const PIPELINE_ICP        = 13964159;
const STATUS_ICP_BASE     = 107767847;  // estágio "Base"

const PIPELINE_NAO_ICP    = 14005591;
const STATUS_NAO_ICP_NOVO = 108097647;  // estágio "Novo"

// A única faixa que NÃO é ICP
const STR_NAO_ICP = 'abaixo de r$20k';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
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

    const pipelineId = isICP ? PIPELINE_ICP     : PIPELINE_NAO_ICP;
    const statusId   = isICP ? STATUS_ICP_BASE  : STATUS_NAO_ICP_NOVO;
    const tag        = isICP ? 'Funil Diagnóstico — ICP' : 'Funil Diagnóstico — Não-ICP';
    const nota       = montarNota({ isICP, instagram, username, renda });

    const ok = await criarLeadNoKommo({ nome, telefone, email, tag, nota, pipelineId, statusId });

    if (!ok) {
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
    L.push(`1. Abrir Instagram @${username} e anotar 1-2 observações reais.`);
    L.push('2. Preparar diagnóstico (agente IA no Claude).');
    L.push('3. Enviar via WhatsApp em até 24h.');
  } else {
    L.push('▶ PRÓXIMO PASSO');
    L.push('Lead fora do perfil de diagnóstico (renda < R$20k/mês).');
    L.push('Avaliar fit com: mentoria, assessoria, criativos, tráfego pago isolado.');
  }

  return L.join('\n');
}

async function criarLeadNoKommo({ nome, telefone, email, tag, nota, pipelineId, statusId }) {
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
    name:        `[Diagnóstico] ${nome}`,
    pipeline_id: pipelineId,
    status_id:   statusId,
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

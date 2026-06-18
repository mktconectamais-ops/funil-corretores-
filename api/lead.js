// api/lead.js
// Conecta+ — Funil Diagnóstico
// ─────────────────────────────────────────────────────────────
// Fluxo:
// 1. Recebe submissão do formulário (nome, telefone, email, instagram, renda).
// 2. Classifica por faixa de renda:
//    - Renda >= R$20k/mês  → ICP (recebe diagnóstico)
//    - Renda <  R$20k/mês  → Não-ICP (entra no Kommo em outro pipeline, sem diagnóstico)
// 3. Se ICP: tenta puxar métricas do Instagram via Business Discovery,
//    e pede ao Claude um diagnóstico de posicionamento usando esses números.
// 4. Cria o lead no Kommo com tag apropriada e uma nota contendo o diagnóstico
//    (pro Wendell copiar e enviar manualmente por WhatsApp/email).
// 5. Devolve ao frontend o tipo do lead (icp | nao_icp) pra mostrar a tela certa.
 
const KOMMO_SUBDOMAIN  = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN      = process.env.KOMMO_TOKEN;
const META_IG_TOKEN    = process.env.META_IG_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
 
// Conta @mktconectamais (Conecta+) — é a conta "ponte" que faz a chamada de Business Discovery
const IG_USER_ID = '17841463478285841';
 
// A única faixa que NÃO é ICP. Tudo o mais recebe diagnóstico.
const STR_NAO_ICP = 'abaixo de r$20k';
 
// Pede à Vercel até 60s — Business Discovery + Claude podem somar 15–30s
export const config = { maxDuration: 60 };
 
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
 
    let diagnostico       = null;
    let metricas          = null;
    let perfilEncontrado  = false;
 
    if (isICP) {
      // 1) Tenta puxar métricas reais via Business Discovery
      try {
        metricas = await businessDiscovery(username);
        perfilEncontrado = !!metricas;
      } catch (err) {
        console.warn('Business Discovery falhou:', err.message);
      }
 
      // 2) Gera diagnóstico com Claude (mesmo se a conta for pessoal —
      //    o diagnóstico passa a focar no fato de o cara não estar em conta profissional)
      try {
        diagnostico = await gerarDiagnostico({
          nome, username, renda, metricas, perfilEncontrado
        });
      } catch (err) {
        console.warn('Claude falhou:', err.message);
        diagnostico =
          `[FALHA NA GERAÇÃO IA — ANALISAR MANUALMENTE]\n\n` +
          `Perfil: @${username}\nFaixa: ${renda}\nErro: ${err.message}`;
      }
    }
 
    const nota = montarNota({
      isICP, instagram, username, renda, metricas, diagnostico, perfilEncontrado
    });
 
    const tag = isICP ? 'Funil Diagnóstico — ICP' : 'Funil Diagnóstico — Não-ICP';
 
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
 
async function businessDiscovery(username) {
  if (!username) return null;
 
  const fields =
    `business_discovery.username(${username})` +
    `{biography,followers_count,follows_count,media_count,` +
    `media.limit(12){caption,like_count,comments_count,media_type,timestamp,permalink}}`;
 
  const url =
    `https://graph.facebook.com/v25.0/${IG_USER_ID}` +
    `?fields=${encodeURIComponent(fields)}&access_token=${META_IG_TOKEN}`;
 
  const resp = await fetch(url);
  const data = await resp.json();
 
  if (!resp.ok || data.error || !data.business_discovery) {
    if (data.error) console.warn('BD erro:', data.error.message);
    return null;
  }
 
  const bd    = data.business_discovery;
  const posts = bd.media?.data || [];
 
  const totalLikes    = posts.reduce((s, p) => s + (p.like_count     || 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p.comments_count || 0), 0);
  const avgLikes      = posts.length ? totalLikes    / posts.length : 0;
  const avgComments   = posts.length ? totalComments / posts.length : 0;
 
  const engajamento = bd.followers_count > 0
    ? ((avgLikes + avgComments) / bd.followers_count) * 100
    : 0;
 
  const mix = posts.reduce((acc, p) => {
    acc[p.media_type] = (acc[p.media_type] || 0) + 1;
    return acc;
  }, {});
 
  const agora       = Date.now();
  const noventaDias = 90 * 24 * 60 * 60 * 1000;
  const recentes    = posts.filter(p => (agora - new Date(p.timestamp).getTime()) < noventaDias).length;
  const postsPorMes = (recentes / 3).toFixed(1);
 
  return {
    biography:     bd.biography || '',
    followers:     bd.followers_count,
    following:     bd.follows_count,
    totalPosts:    bd.media_count,
    razaoSeguindo: bd.followers_count > 0
      ? (bd.follows_count / bd.followers_count).toFixed(2)
      : 'N/A',
    engajamentoPct: engajamento.toFixed(2),
    avgLikes:       Math.round(avgLikes),
    avgComments:    Math.round(avgComments),
    postsPorMes,
    mixConteudo:    mix,
    ultimosPosts:   posts.slice(0, 6).map(p => ({
      tipo:        p.media_type,
      curtidas:    p.like_count     || 0,
      comentarios: p.comments_count || 0,
      legenda:     (p.caption || '').slice(0, 250)
    }))
  };
}
 
async function gerarDiagnostico({ nome, username, renda, metricas, perfilEncontrado }) {
  let contextoMetrico;
 
  if (!perfilEncontrado) {
    contextoMetrico =
      `OBSERVAÇÃO IMPORTANTE: o perfil @${username} NÃO retornou dados via Business Discovery. ` +
      `Isso quase sempre significa uma de três coisas: (1) é uma conta pessoal, não profissional; ` +
      `(2) o username foi digitado errado; (3) é um perfil muito novo. Use esse fato como o ` +
      `achado central do diagnóstico: corretor que vende médio/alto padrão e ainda não migrou ` +
      `pra conta profissional perde acesso a tráfego pago, criativos avançados, mensagens ` +
      `automatizadas, analytics e atribuição. Aponte isso como o ajuste #1 e explique o que ele ganha mudando.`;
  } else {
    const mixStr = Object.entries(metricas.mixConteudo)
      .map(([k, v]) => `${k}: ${v}`).join(', ');
 
    const legendas = metricas.ultimosPosts
      .map((p, i) => `Post ${i+1} (${p.tipo}, ${p.curtidas} curtidas, ${p.comentarios} comentários): "${p.legenda}"`)
      .join('\n');
 
    contextoMetrico = `DADOS PÚBLICOS DE @${username}:
- Bio: "${metricas.biography || '(vazia)'}"
- Seguidores: ${metricas.followers}
- Seguindo: ${metricas.following}
- Razão seguindo/seguidores: ${metricas.razaoSeguindo}
- Total de posts: ${metricas.totalPosts}
- Frequência últimos 90 dias: ~${metricas.postsPorMes} posts/mês
- Engajamento médio: ${metricas.engajamentoPct}% (média de ${metricas.avgLikes} curtidas e ${metricas.avgComments} comentários por post)
- Mix de conteúdo nos últimos 12 posts: ${mixStr}
 
ÚLTIMOS POSTS (amostra com legendas):
${legendas}`;
  }
 
  const prompt = `Você é o consultor sênior de marketing digital da Conecta+, uma agência especializada em corretores de imóveis autônomos de médio/alto padrão. Seu trabalho aqui é entregar um diagnóstico de posicionamento honesto, direto e útil — não um relatório de elogio, não uma listagem genérica, não um pitch de venda.
 
CONTEXTO DO LEAD:
- Nome: ${nome}
- Renda mensal declarada com vendas: ${renda}
- Instagram: @${username}
 
${contextoMetrico}
 
INSTRUÇÕES DE ESTILO:
1. Escreva em português brasileiro, tom consultivo e direto. Sem floreio, sem "parabéns pelo trabalho", sem disclaimers vagos.
2. Use os NÚMEROS REAIS acima — cite-os explicitamente quando relevantes.
3. Estrutura sugerida: um parágrafo de leitura geral (o que os dados dizem), 3 a 5 fraquezas específicas numeradas, e 2 a 3 ajustes prioritários em ordem de impacto.
4. Termine com 1 ou 2 perguntas estratégicas que abram conversa — não chamadas genéricas tipo "vamos agendar uma call".
5. Limite a ~400 palavras.
6. Formatação leve: **negrito** pontual e listas numeradas. Sem títulos com ## ou ###.
 
NÃO FAÇA:
- Não elogie sem motivo concreto.
- Não use jargão vazio ("posicionamento estratégico", "autoridade no mercado", "conteúdo de valor").
- Não recomende coisas óbvias que qualquer perfil deveria fazer ("postar mais", "engajar com seguidores").
- Não invente dados que não estão acima.
- Não mencione preços ou planos da Conecta+.
 
Comece o diagnóstico diretamente, sem preâmbulo.`;
 
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }]
    })
  });
 
  const data = await resp.json();
 
  if (!resp.ok) {
    throw new Error(data.error?.message || `Claude HTTP ${resp.status}`);
  }
 
  const textBlock = (data.content || []).find(c => c.type === 'text');
  if (!textBlock) throw new Error('Resposta do Claude sem bloco de texto.');
 
  return textBlock.text.trim();
}
 
function montarNota({ isICP, instagram, username, renda, metricas, diagnostico, perfilEncontrado }) {
  const L = [];
 
  L.push('🎯 LEAD DO FUNIL DIAGNÓSTICO');
  L.push('═══════════════════════════');
  L.push('');
  L.push(`📱 Instagram: ${instagram} (@${username})`);
  L.push(`💰 Faixa de renda: ${renda}`);
  L.push(`🏷️ Classificação: ${isICP ? '✅ ICP (recebe diagnóstico)' : '⚠️ Fora do perfil ICP'}`);
  L.push('');
 
  if (!isICP) {
    L.push('Lead fora do perfil de diagnóstico (renda < R$20k/mês).');
    L.push('Possível audiência para: mentoria, assessoria, captação e edição de conteúdo.');
    return L.join('\n');
  }
 
  if (perfilEncontrado && metricas) {
    L.push('📊 MÉTRICAS DO PERFIL');
    L.push('───────────────────');
    L.push(`Seguidores: ${metricas.followers}`);
    L.push(`Seguindo: ${metricas.following}`);
    L.push(`Total de posts: ${metricas.totalPosts}`);
    L.push(`Frequência: ~${metricas.postsPorMes} posts/mês`);
    L.push(`Engajamento: ${metricas.engajamentoPct}%`);
    L.push(`Média curtidas/post: ${metricas.avgLikes}`);
    L.push(`Média comentários/post: ${metricas.avgComments}`);
    L.push('');
  } else {
    L.push('⚠️ Perfil NÃO retornou dados via API.');
    L.push('Provável causa: conta pessoal, username inválido, ou perfil muito novo.');
    L.push('');
  }
 
  L.push('📝 DIAGNÓSTICO (PARA ENVIAR AO LEAD)');
  L.push('═══════════════════════════════════════');
  L.push('');
  L.push(diagnostico);
  L.push('');
  L.push('═══════════════════════════════════════');
  L.push('☝️ Copie o texto acima e envie ao lead via WhatsApp ou email.');
 
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
    // Não retornamos false — o lead existe, a nota se perdeu mas dá pra ver depois
  }
 
  return true;
}

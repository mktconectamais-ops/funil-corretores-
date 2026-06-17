// Função serverless da Vercel: recebe o lead do formulário e cria no Kommo.
// Precisa de duas variáveis de ambiente configuradas no projeto da Vercel:
//   KOMMO_SUBDOMAIN  -> ex: mktconectamais
//   KOMMO_TOKEN      -> o token de longa duração gerado na integração privada do Kommo

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const token = process.env.KOMMO_TOKEN;

  if (!subdomain || !token) {
    console.error('Variáveis de ambiente do Kommo não configuradas.');
    res.status(500).json({ error: 'Configuração do Kommo ausente' });
    return;
  }

  try {
    const { instagram, renda, nome, email, telefone } = req.body || {};

    if (!nome || !email || !telefone) {
      res.status(400).json({ error: 'Dados obrigatórios faltando' });
      return;
    }

    const baseUrl = `https://${subdomain}.kommo.com/api/v4`;

    // 1) cria o lead já com o contato embutido
    const leadPayload = [
      {
        name: `Funil Corretores — ${nome}`,
        _embedded: {
          contacts: [
            {
              first_name: nome,
              custom_fields_values: [
                {
                  field_code: 'PHONE',
                  values: [{ value: telefone, enum_code: 'WORK' }]
                },
                {
                  field_code: 'EMAIL',
                  values: [{ value: email, enum_code: 'WORK' }]
                }
              ]
            }
          ]
        }
      }
    ];

    const leadResponse = await fetch(`${baseUrl}/leads/complex`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(leadPayload)
    });

    if (!leadResponse.ok) {
      const errText = await leadResponse.text();
      console.error('Erro ao criar lead no Kommo:', leadResponse.status, errText);
      res.status(502).json({ error: 'Erro ao criar lead no Kommo' });
      return;
    }

    const leadData = await leadResponse.json();
    const leadId = leadData?.[0]?.id;

    // 2) adiciona uma nota no lead com os dados que não têm campo padrão (IG e renda)
    if (leadId) {
      const notePayload = [
        {
          note_type: 'common',
          params: {
            text: `Instagram: ${instagram || 'não informado'}\nRenda mensal média: ${renda || 'não informado'}`
          }
        }
      ];

      const noteResponse = await fetch(`${baseUrl}/leads/${leadId}/notes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(notePayload)
      });

      if (!noteResponse.ok) {
        // não falha a requisição inteira por isso, só loga -- o lead já foi criado
        const errText = await noteResponse.text();
        console.error('Lead criado, mas falhou ao adicionar nota:', noteResponse.status, errText);
      }
    }

    res.status(200).json({ success: true, leadId });
  } catch (err) {
    console.error('Erro inesperado:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
};

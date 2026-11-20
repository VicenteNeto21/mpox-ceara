# Mpox Ceará — Painel Epidemiológico

Projeto estático com HTML5, CSS3, Bootstrap 5 e JavaScript puro.

## Executar
1. Extraia a pasta.
2. Abra no VS Code.
3. Execute `index.html` com a extensão Live Server (recomendado).
4. Clique em **Atualizar dados** para consultar a API.

## Fonte
Endpoint documentado no Swagger do Ministério da Saúde:
`https://apidadosabertos.saude.gov.br/vigilancia-e-meio-ambiente/mpox`

Documentação:
`https://apidadosabertos.saude.gov.br/static/swagger.json`

Conjunto de dados:
`https://dadosabertos.saude.gov.br/dataset/mpox`

## Atenção à integração
A documentação consultada descreve `limit` e `offset` para a rota Mpox, mas não documenta filtro de UF nessa rota. Por isso, o front-end percorre páginas e tenta identificar registros do Ceará por UF, código IBGE (prefixo 23) ou nome de município.

O formato do JSON pode mudar. Se os campos de município, data, classificação ou evolução não coincidirem com os nomes tratados em `app.js`, ajuste as listas de chaves nas funções `isCeara`, `getCity`, `getDate`, `getStatus` e `getEvolution`.

Os cartões de confirmados, suspeitos e óbitos mostram `N/D` quando a API não fornece campos que permitam calcular esses indicadores com segurança. Não substitua `N/D` por zero: ausência de campo não significa ausência de casos.

A consulta é feita diretamente no navegador. Se houver bloqueio CORS, indisponibilidade ou exigência de autenticação, será necessário um pequeno backend intermediário — mesmo mantendo o front-end em HTML, CSS, Bootstrap e JavaScript.

## Aviso
Painel informativo independente. Dados sujeitos a revisão e atraso de atualização. Não substitui os canais oficiais de vigilância em saúde.
# Mpox Ceara

Painel epidemiologico dos dados publicos de Mpox no Ceara.

## Executar

No Windows, em um terminal na pasta do projeto:

```powershell
npm start
```

Depois acesse `http://localhost:5500`.

O servidor local entrega o painel e encaminha a consulta para a API do Ministerio da Saude pela rota `/api/mpox`, evitando o bloqueio de CORS no navegador. Nao abra mais o `index.html` diretamente.

O painel atualiza automaticamente a cada 1 minuto. A rota oficial da API documentada no Swagger aceita somente `limit` e `offset`; o filtro de Ceará e de ano é aplicado pelo painel.

Os dados de 2026 são obtidos do arquivo anual oficial `MPX_2026_OPENDATASUS.csv.zip`. O servidor baixa o ZIP, filtra residentes com UF 23/Ceará e envia os registros ao painel. Os nomes dos municípios vêm da API oficial de localidades do IBGE.

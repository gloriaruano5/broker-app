// Lista inicial de activos de Gloria. Todo se puede cambiar desde la app (Ajustes > editar activo).
// "yahoo" es el símbolo en Yahoo Finance, "sec" el ticker en la SEC de EE. UU. (si presenta cuentas allí),
// "news" el texto que se busca en las noticias y "themes" los temas geopolíticos que le afectan.
// SUPUESTO marca los activos cuyo fondo exacto hay que confirmar con el ISIN.
window.DEFAULT_ASSETS = [
  { id: 'nvda', name: 'NVIDIA', yahoo: 'NVDA', type: 'Acción', sec: 'NVDA', news: 'NVIDIA', themes: ['chips', 'ia', 'china'] },
  { id: 'gold', name: 'Physical Gold USD', yahoo: 'IGLN.L', type: 'Materia prima', news: 'precio del oro', themes: ['oro', 'fed'], note: 'SUPUESTO: iShares Physical Gold ETC (IGLN, USD)' },
  { id: 'vst', name: 'Vistra', yahoo: 'VST', type: 'Acción', sec: 'VST', news: 'Vistra Corp', themes: ['energia', 'ia'] },
  { id: 'water', name: 'Global Water USD (Dist)', yahoo: 'IH2O.L', type: 'ETF', news: 'agua infraestructura inversión', themes: ['agua'], note: 'SUPUESTO: iShares Global Water UCITS ETF (IH2O)' },
  { id: 'mp', name: 'MP Materials', yahoo: 'MP', type: 'Acción', sec: 'MP', news: 'MP Materials', themes: ['tierras', 'china'] },
  { id: 'rddt', name: 'Reddit', yahoo: 'RDDT', type: 'Acción', sec: 'RDDT', news: 'Reddit RDDT', themes: ['ia', 'fed'] },
  { id: 'china', name: 'MSCI China USD (Acc)', yahoo: 'ICHN.L', type: 'ETF', news: 'bolsa China', themes: ['china'], note: 'SUPUESTO: iShares MSCI China UCITS ETF (ICHN)' },
  { id: 'q', name: 'Qnity Electronics', yahoo: 'Q', type: 'Acción', sec: 'Q', news: 'Qnity Electronics', themes: ['chips'] },
  { id: 'dxyz', name: 'Destiny Tech100', yahoo: 'DXYZ', type: 'Fondo cotizado', sec: 'DXYZ', news: 'Destiny Tech100 DXYZ', themes: ['ia', 'fed'] },
  { id: 'hynix', name: 'SK Hynix (GDR)', yahoo: '000660.KS', type: 'Acción', news: 'SK Hynix', themes: ['chips', 'corea', 'ia'], note: 'Se sigue la cotización de Corea (KRW); el GDR replica a la acción.' },
  { id: 'tsm', name: 'TSMC (ADR)', yahoo: 'TSM', type: 'Acción', sec: 'TSM', news: 'TSMC', themes: ['chips', 'taiwan', 'ia'] },
  { id: 'poet', name: 'POET Technologies', yahoo: 'POET', type: 'Acción', sec: 'POET', news: 'POET Technologies', themes: ['chips', 'ia'] },
  { id: 'copx', name: 'Copper Miners USD (Acc)', yahoo: 'COPX.L', type: 'ETF', news: 'mineras de cobre', themes: ['cobre', 'china'], note: 'SUPUESTO: Global X Copper Miners UCITS ETF (COPX)' },
  { id: 'pdd', name: 'Pinduoduo (ADR)', yahoo: 'PDD', type: 'Acción', sec: 'PDD', news: 'PDD Holdings Temu', themes: ['china', 'aranceles'] },
  { id: 'googl', name: 'Alphabet (A)', yahoo: 'GOOGL', type: 'Acción', sec: 'GOOGL', news: 'Alphabet Google', themes: ['ia', 'regulacion'] },
  { id: 'sp500', name: 'Core S&P 500 (Acc)', yahoo: 'CSPX.L', type: 'ETF', news: 'S&P 500', themes: ['fed', 'aranceles'], note: 'SUPUESTO: iShares Core S&P 500 UCITS ETF (CSPX)' },
  { id: 'japan', name: 'MSCI Core Japan JPY (Acc)', yahoo: 'SJPA.L', type: 'ETF', news: 'bolsa Japón Nikkei', themes: ['japon'], note: 'SUPUESTO: iShares Core MSCI Japan IMI (SJPA)' },
  { id: 'copper', name: 'Copper USD', yahoo: 'COPA.L', type: 'Materia prima', news: 'precio del cobre', themes: ['cobre', 'china'], note: 'SUPUESTO: WisdomTree Copper (COPA)' },
  { id: 'mitsu', name: 'Mitsubishi', yahoo: '8058.T', type: 'Acción', news: 'Mitsubishi Corporation', themes: ['japon'], note: 'Mitsubishi Corporation (8058, ISIN JP3898400001), cotiza en Tokio en yenes.' },
  { id: 'btc', name: 'Bitcoin', yahoo: 'BTC-USD', type: 'Cripto', news: 'Bitcoin', themes: ['cripto', 'fed'] },
  { id: 'eth', name: 'Ethereum', yahoo: 'ETH-USD', type: 'Cripto', news: 'Ethereum', themes: ['cripto'] },
  { id: 'sol', name: 'Solana', yahoo: 'SOL-USD', type: 'Cripto', news: 'Solana crypto', themes: ['cripto'] }
];

// Temas geopolíticos y macro: qué se busca en las noticias para cada uno.
window.THEMES = {
  chips: { label: 'Chips y control de exportaciones', q: 'semiconductores exportaciones China Estados Unidos restricciones' },
  ia: { label: 'Inversión en inteligencia artificial', q: 'inteligencia artificial inversión burbuja centros de datos' },
  china: { label: 'Economía china y relación con EE. UU.', q: 'China economía Estados Unidos aranceles' },
  taiwan: { label: 'Tensión en Taiwán', q: 'Taiwán China tensión militar' },
  corea: { label: 'Corea del Sur', q: 'Corea del Sur economía exportaciones chips' },
  japon: { label: 'Japón, yen y Banco de Japón', q: 'Banco de Japón yen tipos de interés' },
  oro: { label: 'Oro y bancos centrales', q: 'oro bancos centrales compras precio récord' },
  fed: { label: 'Reserva Federal, tipos e inflación', q: 'Reserva Federal tipos de interés inflación' },
  cobre: { label: 'Cobre y demanda industrial', q: 'cobre demanda suministro minas precio' },
  energia: { label: 'Electricidad y demanda de centros de datos', q: 'demanda eléctrica centros de datos nuclear' },
  tierras: { label: 'Tierras raras', q: 'tierras raras China exportaciones' },
  agua: { label: 'Agua e infraestructuras', q: 'escasez de agua infraestructura inversión' },
  aranceles: { label: 'Aranceles y comercio', q: 'aranceles comercio internacional Trump' },
  regulacion: { label: 'Regulación tecnológica', q: 'antimonopolio Google regulación tecnológicas' },
  cripto: { label: 'Regulación y flujos cripto', q: 'regulación criptomonedas ETF bitcoin SEC' }
};

// Sector, país y divisa real de exposición de cada activo (para el reparto de la cartera).
window.ASSET_META = {
  nvda: { sector: 'Tecnología / chips', country: 'EE. UU.', fx: 'USD' },
  gold: { sector: 'Oro', country: 'Global', fx: 'USD' },
  vst: { sector: 'Energía eléctrica', country: 'EE. UU.', fx: 'USD' },
  water: { sector: 'Agua e industria', country: 'Global', fx: 'USD' },
  mp: { sector: 'Materiales / tierras raras', country: 'EE. UU.', fx: 'USD' },
  rddt: { sector: 'Internet / redes sociales', country: 'EE. UU.', fx: 'USD' },
  china: { sector: 'Bolsa diversificada', country: 'China', fx: 'CNY/HKD' },
  q: { sector: 'Tecnología / chips', country: 'EE. UU.', fx: 'USD' },
  dxyz: { sector: 'Tecnología no cotizada', country: 'EE. UU.', fx: 'USD' },
  hynix: { sector: 'Tecnología / chips', country: 'Corea del Sur', fx: 'KRW' },
  tsm: { sector: 'Tecnología / chips', country: 'Taiwán', fx: 'USD (TWD)' },
  poet: { sector: 'Tecnología / chips', country: 'Canadá', fx: 'USD' },
  copx: { sector: 'Materiales / cobre', country: 'Global', fx: 'USD' },
  pdd: { sector: 'Comercio electrónico', country: 'China', fx: 'USD (CNY)' },
  googl: { sector: 'Internet / IA', country: 'EE. UU.', fx: 'USD' },
  sp500: { sector: 'Bolsa diversificada', country: 'EE. UU.', fx: 'USD' },
  japan: { sector: 'Bolsa diversificada', country: 'Japón', fx: 'JPY' },
  copper: { sector: 'Materiales / cobre', country: 'Global', fx: 'USD' },
  mitsu: { sector: 'Conglomerado / materias primas', country: 'Japón', fx: 'JPY' },
  btc: { sector: 'Cripto', country: 'Global', fx: 'USD' },
  eth: { sector: 'Cripto', country: 'Global', fx: 'USD' },
  sol: { sector: 'Cripto', country: 'Global', fx: 'USD' }
};

// Reuniones de bancos centrales (día de la decisión). Fuentes: federalreserve.gov y ecb.europa.eu (consultadas 26/11/2026).
window.MACRO_EVENTS = [
  ['2026-12-09', 'Fed: decisión de tipos (con previsiones)'],
  ['2026-12-17', 'BCE: decisión de tipos'],
  ['2027-01-27', 'Fed: decisión de tipos'],
  ['2027-02-04', 'BCE: decisión de tipos'],
  ['2027-03-17', 'Fed: decisión de tipos (con previsiones)'],
  ['2027-03-18', 'BCE: decisión de tipos'],
  ['2027-04-28', 'Fed: decisión de tipos'],
  ['2027-04-29', 'BCE: decisión de tipos'],
  ['2027-06-09', 'Fed: decisión de tipos (con previsiones)'],
  ['2027-06-10', 'BCE: decisión de tipos'],
  ['2027-07-22', 'BCE: decisión de tipos'],
  ['2027-07-28', 'Fed: decisión de tipos'],
  ['2027-09-09', 'BCE: decisión de tipos'],
  ['2027-09-15', 'Fed: decisión de tipos (con previsiones)'],
  ['2027-10-27', 'Fed: reunión de estrategia (sin decisión de tipos)'],
  ['2027-10-28', 'BCE: decisión de tipos'],
  ['2027-11-17', 'Fed: decisión de tipos'],
  ['2027-12-16', 'BCE: decisión de tipos']
];

// Lista inicial de activos de Gloria. Todo se puede cambiar desde la app (Ajustes > editar activo).
// "yahoo" es el símbolo en Yahoo Finance, "sec" el ticker en la SEC de EE. UU. (si presenta cuentas allí),
// "news" el texto que se busca en las noticias y "themes" los temas geopolíticos que le afectan.
// "isin" es el código que aparece en Trade Republic.
window.DEFAULT_ASSETS = [
  { id: 'nvda', name: 'NVIDIA', yahoo: 'NVDA', type: 'Acción', sec: 'NVDA', news: 'NVIDIA', themes: ['chips', 'ia', 'china'] },
  { id: 'gold', name: 'Physical Gold USD', yahoo: 'PPFB.DE', type: 'Materia prima', news: 'precio del oro', themes: ['oro', 'fed'], isin: 'IE00B4ND3602', note: 'iShares Physical Gold ETC (PPFB, Xetra, en euros)' },
  { id: 'vst', name: 'Vistra', yahoo: 'VST', type: 'Acción', sec: 'VST', news: 'Vistra Corp', themes: ['energia', 'ia'] },
  { id: 'water', name: 'Global Water USD (Dist)', yahoo: 'IQQQ.DE', type: 'ETF', news: 'agua infraestructura inversión', themes: ['agua'], isin: 'IE00B1TXK627', note: 'iShares Global Water UCITS ETF (IQQQ, Xetra, en euros)' },
  { id: 'mp', name: 'MP Materials', yahoo: 'MP', type: 'Acción', sec: 'MP', news: 'MP Materials', themes: ['tierras', 'china'] },
  { id: 'rddt', name: 'Reddit', yahoo: 'RDDT', type: 'Acción', sec: 'RDDT', news: 'Reddit RDDT', themes: ['ia', 'fed'] },
  { id: 'china', name: 'MSCI China USD (Acc)', yahoo: 'ICHN.L', alt: ['ICGA.DE', 'ICGA.F', 'ICHN.L'], type: 'ETF', news: 'bolsa China', themes: ['china'], isin: 'IE00BJ5JPG56', resolveIsin: true, note: 'iShares MSCI China UCITS ETF Acc. La cotización en euros se busca por su ISIN.' },
  { id: 'q', name: 'Qnity Electronics', yahoo: 'Q', type: 'Acción', sec: 'Q', news: 'Qnity Electronics', themes: ['chips'] },
  { id: 'dxyz', name: 'Destiny Tech100', yahoo: 'DXYZ', type: 'Fondo cotizado', sec: 'DXYZ', news: 'Destiny Tech100 DXYZ', themes: ['ia', 'fed'], isin: 'US25063F1075' },
  { id: 'hynix', name: 'SK Hynix (GDR)', yahoo: '000660.KS', type: 'Acción', news: 'SK Hynix', themes: ['chips', 'corea', 'ia'], isin: 'US78392B1070', note: 'GDR US78392B1070. Se sigue la acción en Corea (KRW), que es la que mueve el precio del GDR.' },
  { id: 'tsm', name: 'TSMC (ADR)', yahoo: 'TSM', type: 'Acción', sec: 'TSM', news: 'TSMC', themes: ['chips', 'taiwan', 'ia'] },
  { id: 'poet', name: 'POET Technologies', yahoo: 'POET', type: 'Acción', sec: 'POET', news: 'POET Technologies', themes: ['chips', 'ia'] },
  { id: 'copx', name: 'Copper Miners USD (Acc)', yahoo: 'COPX.L', alt: ['4COP.DE', '4COP.F', 'COPX.L'], type: 'ETF', news: 'mineras de cobre', themes: ['cobre', 'china'], isin: 'IE0003Z9E2Y3', resolveIsin: true, note: 'Global X Copper Miners UCITS ETF Acc. La cotización en euros se busca por su ISIN.' },
  { id: 'pdd', name: 'Pinduoduo (ADR)', yahoo: 'PDD', type: 'Acción', sec: 'PDD', news: 'PDD Holdings Temu', themes: ['china', 'aranceles'] },
  { id: 'googl', name: 'Alphabet (A)', yahoo: 'GOOGL', type: 'Acción', sec: 'GOOGL', news: 'Alphabet Google', themes: ['ia', 'regulacion'] },
  { id: 'sp500', name: 'Core S&P 500 (Acc)', yahoo: 'SXR8.DE', type: 'ETF', news: 'S&P 500', themes: ['fed', 'aranceles'], isin: 'IE00B5BMR087', note: 'iShares Core S&P 500 UCITS ETF Acc (SXR8, Xetra, en euros)' },
  { id: 'japan', name: 'MSCI Core Japan JPY (Acc)', yahoo: 'LCUJ.DE', type: 'ETF', news: 'bolsa Japón Nikkei', themes: ['japon'], isin: 'LU1781541252', note: 'Amundi Core MSCI Japan UCITS ETF Acc (LCUJ, Xetra, en euros)' },
  { id: 'copper', name: 'Copper USD', yahoo: 'OD7C.DE', alt: ['OD7C.DE', 'OD7C.F', 'COPA.L', 'COPA.MI'], type: 'Materia prima', news: 'precio del cobre', themes: ['cobre', 'china'], isin: 'GB00B15KXQ89', note: 'WisdomTree Copper (OD7C, Xetra, en euros)' },
  { id: 'mitsu', name: 'Mitsubishi', yahoo: '8058.T', type: 'Acción', news: 'Mitsubishi Corporation', themes: ['japon'], note: 'Mitsubishi Corporation (8058, ISIN JP3898400001), cotiza en Tokio en yenes.' },
  { id: 'nucera', name: 'Thyssenkrupp Nucera', yahoo: 'NCH2.DE', type: 'Acción', news: 'thyssenkrupp nucera', themes: ['hidrogeno', 'energia'], note: 'Cotiza en Xetra, en euros.' },
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
  hidrogeno: { label: 'Hidrógeno verde y subvenciones', q: 'hidrógeno verde electrolizadores subvenciones Europa' },
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
  nucera: { sector: 'Industria / hidrógeno', country: 'Alemania', fx: 'EUR' },
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

// Otros activos del mercado (grandes y líquidos, disponibles en Trade Republic) para buscar oportunidades fuera de la cartera.
window.WATCHLIST = [
  { id: 'w-vwce', name: 'Vanguard FTSE All-World', yahoo: 'VWCE.DE', type: 'ETF', tag: 'Bolsa mundial' },
  { id: 'w-eunl', name: 'iShares Core MSCI World', yahoo: 'EUNL.DE', type: 'ETF', tag: 'Bolsa mundial' },
  { id: 'w-is3n', name: 'iShares MSCI EM IMI', yahoo: 'IS3N.DE', type: 'ETF', tag: 'Emergentes' },
  { id: 'w-exsa', name: 'iShares STOXX Europe 600', yahoo: 'EXSA.DE', type: 'ETF', tag: 'Europa' },
  { id: 'w-sxrv', name: 'iShares Nasdaq 100', yahoo: 'SXRV.DE', type: 'ETF', tag: 'Tecnología EE. UU.' },
  { id: 'w-zprv', name: 'SPDR US Small Cap Value', yahoo: 'ZPRV.DE', type: 'ETF', tag: 'Pequeñas EE. UU.' },
  { id: 'w-aapl', name: 'Apple', yahoo: 'AAPL', type: 'Acción', tag: 'Tecnología' },
  { id: 'w-msft', name: 'Microsoft', yahoo: 'MSFT', type: 'Acción', tag: 'Tecnología' },
  { id: 'w-amzn', name: 'Amazon', yahoo: 'AMZN', type: 'Acción', tag: 'Consumo / nube' },
  { id: 'w-meta', name: 'Meta Platforms', yahoo: 'META', type: 'Acción', tag: 'Tecnología' },
  { id: 'w-avgo', name: 'Broadcom', yahoo: 'AVGO', type: 'Acción', tag: 'Chips' },
  { id: 'w-amd', name: 'AMD', yahoo: 'AMD', type: 'Acción', tag: 'Chips' },
  { id: 'w-asml', name: 'ASML', yahoo: 'ASML.AS', type: 'Acción', tag: 'Chips (Europa)' },
  { id: 'w-sap', name: 'SAP', yahoo: 'SAP.DE', type: 'Acción', tag: 'Software (Europa)' },
  { id: 'w-lly', name: 'Eli Lilly', yahoo: 'LLY', type: 'Acción', tag: 'Salud' },
  { id: 'w-nvo', name: 'Novo Nordisk', yahoo: 'NVO', type: 'Acción', tag: 'Salud' },
  { id: 'w-jpm', name: 'JPMorgan Chase', yahoo: 'JPM', type: 'Acción', tag: 'Bancos' },
  { id: 'w-v', name: 'Visa', yahoo: 'V', type: 'Acción', tag: 'Pagos' },
  { id: 'w-brk', name: 'Berkshire Hathaway B', yahoo: 'BRK-B', type: 'Acción', tag: 'Diversificada' },
  { id: 'w-cost', name: 'Costco', yahoo: 'COST', type: 'Acción', tag: 'Consumo' },
  { id: 'w-tsla', name: 'Tesla', yahoo: 'TSLA', type: 'Acción', tag: 'Automóvil / energía' },
  { id: 'w-orcl', name: 'Oracle', yahoo: 'ORCL', type: 'Acción', tag: 'Software / nube' },
  { id: 'w-itx', name: 'Inditex', yahoo: 'ITX.MC', type: 'Acción', tag: 'Consumo (España)' },
  { id: 'w-san', name: 'Banco Santander', yahoo: 'SAN.MC', type: 'Acción', tag: 'Bancos (España)' },
  { id: 'w-ibe', name: 'Iberdrola', yahoo: 'IBE.MC', type: 'Acción', tag: 'Eléctricas (España)' },
  { id: 'w-mc', name: 'LVMH', yahoo: 'MC.PA', type: 'Acción', tag: 'Lujo (Europa)' },
  { id: 'w-rhm', name: 'Rheinmetall', yahoo: 'RHM.DE', type: 'Acción', tag: 'Defensa (Europa)' },
  { id: 'w-sie', name: 'Siemens', yahoo: 'SIE.DE', type: 'Acción', tag: 'Industria (Europa)' },
  { id: 'w-xrp', name: 'XRP', yahoo: 'XRP-USD', type: 'Cripto', tag: 'Cripto' }
];

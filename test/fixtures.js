'use strict';
// Synthetic EDI files built in code for the tests and the bundled samples. Names, IDs and amounts are made up.
// X12 bodies use '*' and ':' and '~'; x12() rewrites them to the separators asked for.

const X12 = {
  '850': { gs: 'PO', body: "BEG*00*SA*PO-1001**20261110~CUR*BY*USD~REF*DP*042~PER*BD*Jane Buyer*TE*5550100~FOB*PP~ITD*01*3*2**30**60~DTM*002*20261120~TD5*****M~N9*ZZ*NOTE~MSG*Leave at dock 4~N1*BY*Zovo Stores*92*0042~N3*1 Main St~N4*Austin*TX*78701*US~N1*ST*Zovo DC*92*0099~N3*9 Depot Rd~N4*Austin*TX*78744*US~PO1*1*10*EA*4.25*PE*UP*012345678905*VP*ZV-100~PID*F****Blue mug, 300 ml~PO4*6*300*ML~PO1*2*5*CA*30*PE*UP*012345678912*VP*ZV-200~PID*F****Tea towel~SCH*5*CA***002*20261120~CTT*2*15~AMT*TT*192.5" },
  '855': { gs: 'PR', body: 'BAK*00*AC*PO-1001*20261110~REF*VN*SO-88~N1*ST*Zovo DC*92*0099~PO1*1*10*EA*4.25**UP*012345678905~ACK*IA*10*EA*068*20261112~PO1*2*5*CA*30**UP*012345678912~ACK*IB*5*CA*068*20261125~CTT*2' },
  '810': { gs: 'IN', body: 'BIG*20261115*INV-555*20261110*PO-1001~REF*IA*V123~N1*RE*Zovo Supply*92*V1~N1*BT*Zovo Stores*92*0042~ITD*01*3*2**30**60~DTM*011*20261112~IT1*1*10*EA*4.25**UP*012345678905*VP*ZV-100~PID*F****Blue mug~IT1*2*5*CA*30**UP*012345678912*VP*ZV-200~PID*F****Tea towel~TDS*19250~CAD*M***ZOVO~ISS*15*EA~CTT*2' },
  '856': { gs: 'SH', body: 'BSN*00*SHP-77*20261112*1015*0001~HL*1**S~TD1*CTN*3****G*25*LB~TD5**2*ZOVO*M~REF*BM*BOL123~DTM*011*20261112~N1*ST*Zovo DC*92*0099~N1*SF*Zovo Supply*92*V1~HL*2*1*O~PRF*PO-1001***20261110~HL*3*2*P~MAN*GM*00012345600000000017~HL*4*3*I~LIN**UP*012345678905*VP*ZV-100~SN1**10*EA~PID*F****Blue mug~HL*5*2*I~LIN**UP*012345678912*VP*ZV-200~SN1**5*CA~CTT*5' },
  '997': { gs: 'FA', body: 'AK1*PO*1001~AK2*850*0001~AK5*A~AK2*850*0002~AK3*PO1*7**8~AK4*3*355*7*XX~AK5*R*5~AK9*P*2*2*1' },
  '999': { gs: 'FA', ver: '005010X231A1', body: 'AK1*HC*17*005010X222A1~AK2*837*0001*005010X222A1~IK3*NM1*18*2010BA*8~CTX*CLM01:12345~IK4*9*67*1~IK5*R*5~AK9*R*1*1*0' },
  '820': { gs: 'RA', body: 'BPR*C*1500*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*888888888*DA*654321*20261115~TRN*1*EFT-778*1512345678~REF*CR*AR-9~DTM*097*20261115~N1*PR*Zovo Stores~N1*PE*Zovo Supply~ENT*1~RMR*IV*INV-555**1500*1525*25~DTM*003*20261115' },
  '837P': { st: '837', gs: 'HC', ver: '005010X222A1', body: 'BHT*0019*00*BATCH-1*20261110*1200*CH~NM1*41*2*Zovo Billing*****46*SUB1~PER*IC*Billing Desk*TE*5550111~NM1*40*2*Payer Clearing*****46*REC1~HL*1**20*1~PRV*BI*PXC*207Q00000X~NM1*85*2*Zovo Clinic*****XX*1234567893~N3*10 Health Way~N4*Austin*TX*78701~REF*EI*123456789~HL*2*1*22*0~SBR*P*18*GRP1******CI~NM1*IL*1*DOE*JOHN****MI*M12345~N3*5 Elm St~N4*Austin*TX*78702~DMG*D8*19800101*M~NM1*PR*2*Zovo Health Plan*****PI*PAYER1~CLM*PCN-1*150***11:B:1*Y*A*Y*Y~HI*ABK:J069~LX*1~SV1*HC:99213*100*UN*1***1~DTP*472*D8*20261101~LX*2~SV1*HC:87880*50*UN*1***1~DTP*472*D8*20261101' },
  '837I': { st: '837', gs: 'HC', ver: '005010X223A2', body: 'BHT*0019*00*B2*20261110*1200*CH~NM1*41*2*Zovo Billing*****46*SUB1~NM1*40*2*Payer Clearing*****46*REC1~HL*1**20*1~NM1*85*2*Zovo Hospital*****XX*1234567893~N3*1 Care Ave~N4*Austin*TX*78701~REF*EI*123456789~HL*2*1*22*0~SBR*P*18*******MA~NM1*IL*1*ROE*JANE****MI*M2~NM1*PR*2*Medicare*****PI*00431~CLM*PCN-2*2500***11:A:1**A*Y*Y~DTP*434*RD8*20261101-20261103~CL1*1*7*01~HI*ABK:R0789~NM1*71*1*SMITH*ANN****XX*1234567893~LX*1~SV2*0450*HC:99284*2500*UN*1~DTP*472*D8*20261101' },
  '835': { gs: 'HP', ver: '005010X221A1', body: 'BPR*I*120*C*ACH*CCP*01*999999999*DA*123*1512345678**01*888888888*DA*456*20261115~TRN*1*CHK-12345*1512345678~DTM*405*20261114~N1*PR*Zovo Health Plan~N3*2 Plan St~N4*Austin*TX*78703~N1*PE*Zovo Clinic*XX*1234567893~LX*1~CLP*PCN-1*1*150*120*30*12*CLAIM-9~CAS*PR*1*30~NM1*QC*1*DOE*JOHN****MI*M12345~SVC*HC:99213*100*80~DTM*472*20261101~CAS*CO*45*20~SVC*HC:87880*50*40~CAS*CO*45*10' },
  '270': { gs: 'HS', ver: '005010X279A1', body: 'BHT*0022*13*REQ1*20261110*1200~HL*1**20*1~NM1*PR*2*Zovo Health Plan*****PI*PAYER1~HL*2*1*21*1~NM1*1P*2*Zovo Clinic*****XX*1234567893~HL*3*2*22*0~TRN*1*TRACE1*9877281234~NM1*IL*1*DOE*JOHN****MI*M12345~DMG*D8*19800101~DTP*291*D8*20261110~EQ*30' },
  '271': { gs: 'HB', ver: '005010X279A1', body: 'BHT*0022*11*REQ1*20261110*1201~HL*1**20*1~NM1*PR*2*Zovo Health Plan*****PI*PAYER1~HL*2*1*21*1~NM1*1P*2*Zovo Clinic*****XX*1234567893~HL*3*2*22*0~TRN*2*TRACE1*9877281234~NM1*IL*1*DOE*JOHN****MI*M12345~DMG*D8*19800101*M~EB*1**30**GOLD PLAN~EB*B**98***27*25~EB*C**30***23*1500' },
  '276': { gs: 'HR', ver: '005010X212', body: 'BHT*0010*13*REQ2*20261110*1200~HL*1**20*1~NM1*PR*2*Zovo Health Plan*****PI*PAYER1~HL*2*1*21*1~NM1*41*2*Zovo Clinic*****46*SUB1~HL*3*2*19*1~NM1*1P*2*Zovo Clinic*****XX*1234567893~HL*4*3*22*0~DMG*D8*19800101*M~NM1*IL*1*DOE*JOHN****MI*M12345~TRN*1*TRACE2~REF*1K*CLAIM-9~AMT*T3*150~DTP*472*RD8*20261101-20261101' },
  '277': { gs: 'HN', ver: '005010X212', body: 'BHT*0010*08*REQ2*20261111*0900*DG~HL*1**20*1~NM1*PR*2*Zovo Health Plan*****PI*PAYER1~HL*2*1*21*1~NM1*41*2*Zovo Clinic*****46*SUB1~HL*3*2*19*1~NM1*1P*2*Zovo Clinic*****XX*1234567893~HL*4*3*22*0~NM1*IL*1*DOE*JOHN****MI*M12345~TRN*2*TRACE2~STC*F1:65*20261111**150*120~REF*1K*CLAIM-9~DTP*472*RD8*20261101-20261101' },
  '204': { gs: 'SM', body: 'B2**ZOVO**LOAD-55**PP~B2A*00~L11*PO-1001*PO~G62*64*20261112*1*0800~N1*BT*Zovo Stores~S5*1*LD~G62*69*20261112~N1*SF*Zovo Supply~N3*7 Mill Rd~N4*Dallas*TX*75201~OID*REF1*PO-1001**CTN*3*L*25~S5*2*UL~G62*70*20261113~N1*ST*Zovo DC~N3*9 Depot Rd~N4*Austin*TX*78744~L3*25*G' },
  '214': { gs: 'QM', body: 'B10*PRO-123*SHP-77*ZOVO~L11*PO-1001*PO~N1*SF*Zovo Supply~N1*ST*Zovo DC~LX*1~AT7*X6*NS***20261112*1300*LT~MS1*Dallas*TX~MS2*ZOVO*TRK9~LX*2~AT7*D1*NS***20261113*0930*LT~MS1*Austin*TX' },
  '940': { gs: 'OW', body: 'W05*N*ORD-940*PO-1001~N1*ST*Zovo Stores*92*0042~N3*1 Main St~N4*Austin*TX*78701~N9*PO*PO-1001~G62*10*20261112~W66*PP*M~LX*1~W01*10*EA**UP*012345678905~G69*Blue mug~LX*2~W01*5*CA**UP*012345678912~W76*15*EA*25*LB' },
  '945': { gs: 'SW', body: 'W06*N*ORD-940*20261112*SHP-945~N1*ST*Zovo Stores~N9*PO*PO-1001~G62*11*20261112~W27*M*ZOVO~LX*1~MAN*GM*00012345600000000017~W12*CC*10*10**EA**UP*012345678905~LX*2~W12*CC*5*5**CA**UP*012345678912~W03*15*25*LB' },
};

const EDIFACT = {
  ORDERS: "BGM+220+PO-1001+9'DTM+137:20261110:102'DTM+2:20261120:102'FTX+DEL+++Leave at dock 4'RFF+CT:K-77'DTM+171:20260101:102'NAD+BY+5412345000013::9++Zovo Stores'RFF+VA:BE0123456789'CTA+PD+:Jane Buyer'COM+5550100:TE'NAD+SU+5412345000020::9'NAD+DP+5412345000037::9'CUX+2:EUR:9'TDT+20++3'LIN+1++4000862141404:SRV'PIA+1+ZV-100:SA'IMD+F++:::Blue mug'QTY+21:10:PCE'PRI+AAA:4.25'LIN+2++4000862141411:SRV'QTY+21:5'PRI+AAA:30'UNS+S'CNT+2:2'",
  ORDRSP: "BGM+231+RSP-1+4'DTM+137:20261111:102'RFF+ON:PO-1001'NAD+BY+5412345000013::9'NAD+SU+5412345000020::9'LIN+1+5+4000862141404:SRV'QTY+21:10'DTM+2:20261120:102'LIN+2+3+4000862141411:SRV'QTY+21:3'UNS+S'CNT+2:2'",
  DESADV: "BGM+351+DES-77+9'DTM+137:20261112:102'DTM+11:20261112:102'RFF+ON:PO-1001'NAD+SU+5412345000020::9'NAD+DP+5412345000037::9'TDT+20++3'CPS+1'PAC+2++PX'CPS+2+1'PAC+1++CT'PCI+33E'GIN+BJ+354123450000000014'LIN+1++4000862141404:SRV'QTY+12:10'CPS+3+1'PAC+1++CT'PCI+33E'GIN+BJ+354123450000000021'LIN+2++4000862141411:SRV'QTY+12:5'CNT+2:2'",
  INVOIC: "BGM+380+INV-555+9'DTM+137:20261115:102'DTM+35:20261112:102'RFF+ON:PO-1001'NAD+SU+5412345000020::9'RFF+VA:BE0999999999'NAD+BY+5412345000013::9'CUX+2:EUR:4'PAT+1++5:3:D:30'LIN+1++4000862141404:SRV'QTY+47:10'MOA+203:42.5'PRI+AAA:4.25'TAX+7+VAT+++:::21+S'LIN+2++4000862141411:SRV'QTY+47:5'MOA+203:150'PRI+AAA:30'UNS+S'CNT+2:2'MOA+79:192.5'MOA+77:232.93'TAX+7+VAT+++:::21+S'MOA+124:40.43'",
  IFTMIN: "BGM+610+FWD-1+9'DTM+137:20261112:102'TSR+30'RFF+CU:REF-1'TDT+20++3++ZOVO:172:20'LOC+9+DEHAM'LOC+11+BEANR'NAD+CZ+5412345000020::9'NAD+CN+5412345000037::9'GID+1+3:CT'MEA+AAE+G+KGM:25'PCI+24'SGP+CONT1234567'EQD+CN+CONT1234567'",
  PRICAT: "BGM+9+CAT-2027+9'DTM+137:20261110:102'NAD+SU+5412345000020::9'CUX+2:EUR:8'PGI+1'LIN+1++4000862141404:SRV'IMD+F++:::Blue mug'PRI+AAA:4.25'LIN+2++4000862141411:SRV'PRI+AAA:30'UNS+S'CNT+2:2'",
  APERAK: "BGM+305+APK-1+9'DTM+137:20261111:102'RFF+ACW:PO-1001'NAD+MS+5412345000020::9'ERC+12'FTX+AAO+++Unknown item 4000862141411'",
  CONTRL: "UCI+1001+5412345000013:14+5412345000020:14+7'UCM+1+ORDERS:D:96A:UN+4+12'UCS+5+12'UCD+12+3:1'",
};
const VERSION = { ORDERS: 'D:96A:UN:EAN008', ORDRSP: 'D:96A:UN', DESADV: 'D:96A:UN:EAN005', INVOIC: 'D:96A:UN:EAN008', IFTMIN: 'D:01B:UN', PRICAT: 'D:96A:UN', APERAK: 'D:96A:UN', CONTRL: '2:2:UN' };

const pad = (s, n, c = ' ') => String(s).padEnd(n, c).slice(0, n);
const padNum = (n, w) => String(n).padStart(w, '0');

/**
 * An X12 interchange with one functional group per GS kind, every count right.
 * opts: { el, comp, rep, term, nl, ctrl, sender, receiver, version }
 */
function x12(sets, opts = {}) {
  const el = opts.el || '*', comp = opts.comp || ':', rep = opts.rep || '^', term = opts.term || '~', nl = opts.nl === undefined ? '\n' : opts.nl;
  const ctrl = opts.ctrl || 905;
  const conv = (s) => s.split('~').map((seg) => seg.split('*').map((e) => e.split(':').join(comp)).join(el));
  const out = [];
  const seg = (s) => out.push(s + term + nl);
  seg(['ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad(opts.sender || 'ZOVOSENDER', 15), 'ZZ', pad(opts.receiver || 'ZOVORECEIVER', 15), '261110', '1200', rep, opts.version || '00501', padNum(ctrl, 9), '0', 'T', comp].join(el));
  const groups = [];
  for (const key of sets) {
    const def = X12[key];
    if (!def) throw new Error('no fixture ' + key);
    let g = groups.find((x) => x.gs === def.gs && x.ver === (def.ver || '005010'));
    if (!g) { g = { gs: def.gs, ver: def.ver || '005010', sets: [] }; groups.push(g); }
    g.sets.push(def);
  }
  let gctrl = 1, st = 1;
  for (const g of groups) {
    seg(['GS', g.gs, 'ZOVOSENDER', 'ZOVORECEIVER', '20261110', '1200', String(gctrl), 'X', g.ver].join(el));
    for (const d of g.sets) {
      const body = conv(d.body);
      const code = d.st || Object.keys(X12).find((k) => X12[k] === d);
      const c = padNum(st++, 4);
      seg(['ST', code, c, ...(d.ver ? [d.ver] : [])].join(el));
      for (const b of body) seg(b);
      seg(['SE', String(body.length + 2), c].join(el));
    }
    seg(['GE', String(g.sets.length), String(gctrl)].join(el));
    gctrl++;
  }
  seg(['IEA', String(groups.length), padNum(ctrl, 9)].join(el));
  return out.join('');
}

/** An EDIFACT interchange (UNA optional) with the messages given. opts: { una, nl, sep } */
function edifact(msgs, opts = {}) {
  const s = { component: ':', element: '+', decimal: '.', release: '?', segment: "'", ...(opts.sep || {}) };
  const nl = opts.nl === undefined ? '\n' : opts.nl;
  const conv = (txt) => txt.split("'").filter(Boolean).map((seg) => seg.split('+').map((e) => e.split(':').join(s.component)).join(s.element));
  const out = [];
  if (opts.una !== false) out.push(`UNA${s.component}${s.element}${s.decimal}${s.release} ${s.segment}${nl}`);
  const seg = (x) => out.push(x + s.segment + nl);
  seg(['UNB', ['UNOC', '3'].join(s.component), ['5412345000013', '14'].join(s.component), ['5412345000020', '14'].join(s.component), ['261110', '1200'].join(s.component), '1001'].join(s.element));
  let ref = 1;
  for (const m of msgs) {
    const body = conv(EDIFACT[m]);
    const r = String(ref++);
    seg(['UNH', r, [m, ...VERSION[m].split(':')].join(s.component)].join(s.element));
    for (const b of body) seg(b);
    seg(['UNT', String(body.length + 2), r].join(s.element));
  }
  seg(['UNZ', String(msgs.length), '1001'].join(s.element));
  return out.join('');
}

/** A large X12 file: `lines` purchase order lines in one 850 (n segments = lines * 2 + 8 or so). */
function bigX12(lines) {
  const parts = ['ISA*00*          *00*          *ZZ*ZOVOSENDER     *ZZ*ZOVORECEIVER   *261110*1200*^*00501*000000777*0*T*:~', 'GS*PO*ZOVOSENDER*ZOVORECEIVER*20261110*1200*7*X*005010~', 'ST*850*0001~', 'BEG*00*SA*PO-BIG**20261110~'];
  for (let i = 1; i <= lines; i++) parts.push(`PO1*${i}*1*EA*1.00**UP*0${String(i).padStart(11, '0')}~`, `PID*F****Item ${i}~`);
  parts.push(`CTT*${lines}~`, `SE*${lines * 2 + 4}*0001~`, 'GE*1*7~', 'IEA*1*000000777~');
  return parts.join('');
}

module.exports = { X12, EDIFACT, x12, edifact, bigX12 };

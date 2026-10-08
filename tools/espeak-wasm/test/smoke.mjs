import { createPhonemizer } from '../dist/index.mjs';

const ph = await createPhonemizer();
console.log(ph.version, ph.resolveVoice('de'), ph.resolveVoice('en-us'), ph.resolveVoice('en-gb'), ph.resolveVoice('xx'));
for (const t of ['Hallo Welt, wie geht es dir? Ich heiße Jürgen.', 'Das Meeting ist um 14:30 Uhr am 3.10.2025.', '']) {
  console.log(JSON.stringify(ph.phonemizeClauses(t, 'de')));
}
console.log(JSON.stringify(ph.phonemizeLikePythonPhonemizer('Hallo, Welt! Das ist ein Test.', 'de')));
ph.close();

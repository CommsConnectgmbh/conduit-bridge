# Erzeugt einen breiten deutschen Testkorpus fuer Normalisierungs-/Phonem-Paritaet.
import json, random
random.seed(42)
words = "Rechner Brücke Fluss Straße Häuser Mütter Glück Größe Übung Ärger Öl Konferenz Bahnhof Datenschutz Arbeitsgemeinschaft Donaudampfschifffahrt Bundesverfassungsgericht Cloud Server Update Meeting Feedback Workflow GitHub Claude Gemini Ollama Kokoro API JSON Python TypeScript".split()
templates = [
 "Am {d}.{m}.{y} um {h}:{mi} Uhr kostete es {e},{c} €.", "Er zahlte €{e}.{c} und $ {e2}.", "Wir treffen uns {h}:{mi}.", "Der {n}. Platz ging an {w}.",
 "Im Jahr {y} gab es {n} {w}.", "Ruf an: 089 {p1} {p2} oder 0151-{p3}.", "Das sind {g} Personen und {f} Prozent.", "Es sind {n}% mehr als {n2},{c}.",
 "Dr. Müller und Prof. Schmidt wohnen in der Hauptstr. {n}.", "Nr. {n} gem. § {n2} Abs. {n3} BGB, vgl. §§ {n} ff.", "z. B. {w}, d. h. {w2}, u. a. {w3} usw.",
 "Die Comms Connect GmbH und die Muster AG, Tel. {p1}.", "Fr. Meier kommt am {n}. Okt. {y}.", "Zeit {h2}:{mi2} ist ungültig, 25:99 auch.", "{big} Menschen leben dort.",
 "„{w}“ sagte er, ‚{w2}‘ und «{w3}» — wirklich?", "Ca. {n} km, inkl. {n2} Std., exkl. Steuer, ggf. mehr, i. d. R. weniger, o. ä., u. U. nicht.",
 "Version {n}.{n2}.{n3} von {w} ist da!", "Kosten: {e}.{c3},{c} €; Rabatt {f},{c}%.", "Am 31.12.1999 und vom 1.1.2000 bis zum 29.2.2024.",
 "Dipl.-Ing. {w} und Dipl. Ing. {w2}.", "{w}\t{w2} {w3} Ende.", "Zeile eins\n\n\n\nZeile zwei", "  Leerzeichen  am   Anfang   ", "",
 "Mit ½ und ² und ٣ und ３ Zahlen.", "Der 100. und der 1000. Gast, der 1. und 7. und 8. Rang.", "{n} {w}, {n2} {w2}: {n3}!", "Preis 0,5 € und 0,005 € und 1,995 €.",
]
def r(a, b): return str(random.randint(a, b))
out = []
for i in range(3000):
    t = random.choice(templates)
    out.append(t.format(d=r(1, 35), m=r(1, 13), y=r(1000, 2100), h=r(0, 23), mi=f"{random.randint(0,59):02d}", h2=r(24, 99), mi2=r(60, 99),
        e=r(0, 99999), c=f"{random.randint(0,99):02d}", c3=f"{random.randint(0,999):03d}", e2=r(1, 999), n=r(0, 3000), n2=r(1, 500), n3=r(1, 20), w=random.choice(words), w2=random.choice(words), w3=random.choice(words),
        p1=r(1000, 9999), p2=r(10, 999999), p3=r(1000000, 9999999), g=f"{random.randint(1,999)}.{random.randint(0,999):03d}.{random.randint(0,999):03d}", f=r(0, 100), big=str(random.randint(10**6, 10**22))))
json.dump(out, open("corpus_de.json", "w"), ensure_ascii=False)
print(len(out))

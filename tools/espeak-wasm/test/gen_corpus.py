#!/usr/bin/env python3
"""Deterministic test corpus for the espeak-ng WASM parity tests.

usage: gen_corpus.py <out.json>

Writes {"de": [{"id","cat","text"}...], "en": [...]} with >= 3000 German and
>= 1500 English entries covering numbers, dates, times, abbreviations,
umlauts/ß, compounds, loan words, URLs/e-mail, punctuation, emojis, very long
sentences, empty/whitespace-only strings, control and special characters,
Unicode normalisation variants and foreign scripts.
"""
import json
import random
import sys
import unicodedata

R = random.Random(20261008)


def pick(seq):
    return R.choice(seq)


# ----------------------------------------------------------------- German ---
DE_SUBJ = ["Der Kunde", "Die Kundin", "Unser Team", "Das Unternehmen", "Meine Mutter", "Der Techniker",
           "Die Ärztin", "Ein Mitarbeiter", "Die Bürgermeisterin", "Der Busfahrer", "Das Kind", "Die Lehrerin",
           "Herr Müller", "Frau Schröder", "Der Geschäftsführer", "Die Polizei", "Mein Großvater", "Die Bäckerei",
           "Der Hausmeister", "Die Straßenbahn", "Jürgen", "Björn", "Die Gemeinde Höchstädt", "Der Verein"]
DE_VERB = ["kommt", "bezahlt", "bestellt", "überprüft", "verschiebt", "öffnet", "schließt", "repariert",
           "empfiehlt", "liefert", "kündigt", "bestätigt", "vergisst", "begrüßt", "erklärt", "übernimmt",
           "fährt", "läuft", "schläft", "isst", "weiß", "heißt", "grüßt", "genießt"]
DE_OBJ = ["die Rechnung", "das Paket", "den Vertrag", "die Größe", "das Frühstück", "die Übersicht",
          "den Schlüssel", "die Straße", "das Fußballspiel", "die Äpfel", "den Käse", "das Öl",
          "die Bücher", "den Lärm", "die Gebühr", "das Ergebnis", "die Bestätigung", "den Führerschein",
          "die Überweisung", "das Gemüse", "die Brötchen", "den Kühlschrank", "die Tür", "das Märchen"]
DE_ADV = ["heute", "morgen früh", "übermorgen", "sofort", "nächste Woche", "gegen Mittag", "pünktlich",
          "leider nicht", "schon wieder", "vielleicht später", "äußerst schnell", "ziemlich spät",
          "im Büro", "zu Hause", "in München", "in Köln", "an der Ostsee", "im Schwarzwald", "in Zürich", "in Wien"]
DE_COMPOUNDS = ["Donaudampfschifffahrtsgesellschaftskapitän", "Kraftfahrzeughaftpflichtversicherung",
                "Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz", "Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung",
                "Bundesausbildungsförderungsgesetz", "Arbeiterunfallversicherungsgesetz", "Fußballweltmeisterschaftsqualifikationsspiel",
                "Hochgeschwindigkeitszug", "Straßenbahnhaltestelle", "Mehrwertsteuererhöhung", "Datenschutzgrundverordnung",
                "Lebensversicherungsgesellschaft", "Schifffahrt", "Flussschifffahrt", "Brennnessel", "Teeei", "Seeelefant",
                "Wasserstoffbetriebene Fahrzeuge", "Unabhängigkeitserklärung", "Gesundheitsministerium", "Bahnhofsvorplatz",
                "Kindergartenplatzvergabe", "Glühweinstand", "Weihnachtsmarktbesucher", "Rechtsschutzversicherungsgesellschaften",
                "Eierschalensollbruchstellenverursacher", "Nahrungsmittelunverträglichkeit", "Altersteilzeitvereinbarung",
                "Haftpflichtversicherungsbeitrag", "Feuerwehrhauptmann", "Unterhaltungselektronik", "Klimaanlagenwartung"]
DE_LOAN = ["Meeting", "Software", "Computer", "Handy", "Smartphone", "Download", "Feedback", "Team", "Job", "Restaurant",
           "Chance", "Portemonnaie", "Café", "Niveau", "Pizza", "cool", "okay", "Workshop", "Laptop", "Update",
           "Deadline", "Homeoffice", "Startup", "Know-how", "Babysitter", "Jeans", "Baby", "Bike", "Drive", "Coach",
           "Event", "Service", "Account", "E-Mail", "Newsletter", "Influencer", "Spaghetti", "Croissant", "Garage",
           "Ingenieur", "Journalist", "Genre", "Bonbon", "Champignon", "Friseur", "Massage", "Blamage", "Regisseur",
           "Shampoo", "Interview", "Fairness", "Recycling", "Container", "Airbag", "Boom", "Crew", "Free", "Green",
           "Guide", "High", "Blue", "Air", "Deal", "Cup", "Board", "Cowboy", "Entertainment", "Highlight", "Sightseeing"]
DE_ABBR = ["z. B.", "z.B.", "usw.", "bzw.", "Dr.", "Prof.", "Nr.", "ca.", "d. h.", "u. a.", "GmbH", "AG", "e. V.",
           "EU", "USA", "BMW", "ADAC", "km/h", "kg", "m²", "m³", "°C", "%", "‰", "ggf.", "inkl.", "MwSt.", "Str.",
           "Tel.", "Fa.", "Hr.", "Fr.", "S.", "Abs.", "Art.", "vgl.", "etc.", "o. Ä.", "u. U.", "z. T.", "i. d. R.",
           "ARD", "ZDF", "DB", "ICE", "SPD", "CDU", "FDP", "NATO", "UNO", "PKW", "LKW", "WLAN", "PIN", "TÜV", "ÖPNV",
           "Jh.", "Mio.", "Mrd.", "Tsd.", "min", "Std.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."]
DE_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
             "November", "Dezember", "Jan.", "Feb.", "Okt.", "Dez."]
DE_UMLAUT_WORDS = ["Straße", "Größe", "Übergröße", "Ärger", "Öl", "Bär", "Mädchen", "Brötchen", "Fräulein", "Süßigkeiten",
                   "Fußgängerübergang", "Äußerung", "ÜBERGRÖSSE", "STRASSE", "GROẞ", "Maß", "Masse", "Buße", "Busse",
                   "weiß", "weiss", "Grüße", "Füße", "Flöße", "Schlösser", "Küken", "Höhle", "Hölle", "Mühle", "Möhre",
                   "Ökologie", "Übung", "Äpfel", "Öffnungszeiten", "Überraschung", "Gänsefüßchen", "Spaß", "Fußball"]

PUNCT_PAIRS = [("„", "“"), ("»", "«"), ("‚", "‘"), ('"', '"'), ("(", ")"), ("[", "]"), ("{", "}"), ("«", "»"), ("“", "”"), ("'", "'")]
EMOJIS = ["😀", "👍", "👍🏽", "🇩🇪", "❤️", "👨‍👩‍👧‍👦", "🎉", "😂", "🙈", "✅", "⚠️", "☕", "🚀", "💶", "🍺", "🤔", "😢", "🔥", "✨", "1️⃣", "©️", "🏳️‍🌈", "👩🏻‍💻"]
SPECIAL = ["\u00a0", "\t", "\n", "\r\n", "\u200b", "\u00ad", "\u2009", "\u202f", "\u3000", "\ufeff", "\u2028", "\u0085",
           "\u001c", "\u000b", "\u000c"]
SYMBOLS = ["§", "©", "®", "™", "±", "×", "÷", "≤", "≥", "≠", "→", "←", "•", "·", "°", "µ", "½", "¼", "¾", "²", "³",
           "€", "$", "£", "¥", "&", "+", "=", "<", ">", "|", "\\", "^", "~", "`", "*", "_", "#", "@", "/", "%", "∞", "√", "∑", "π", "Ω"]
URLS = ["https://www.example.com/pfad?x=1&y=2", "http://test.de", "www.bundesregierung.de", "info@firma.de",
        "max.mustermann@example.org", "https://de.wikipedia.org/wiki/Straße", "ftp://files.example.net/a_b-c.zip",
        "C:\\Programme\\Datei.txt", "/usr/local/bin", "user_name@sub.domain.co.uk", "https://t.co/AbC123",
        "#Hashtag", "@handle", "localhost:8080", "192.168.0.1", "v1.2.3", "ISBN 978-3-16-148410-0"]
POLISH = ["Gdańsk", "Łódź", "Wałęsa", "Kraków", "Wrocław", "Poznań", "Szczecin", "Bydgoszcz", "Częstochowa",
          "Białystok", "Zieliński", "Wiśniewski", "Dąbrowski", "Kowalczyk", "Józef Piłsudski", "Małgorzata", "Świnoujście"]
FOREIGN_SCRIPTS = ["Ελλάδα", "αβγ", "Москва", "Привет мир", "東京", "北京欢迎你", "こんにちは", "안녕하세요", "שלום", "مرحبا",
                   "नमस्ते", "ქართული", "Հայաստան", "ภาษาไทย", "α-Strahlung", "β-Version", "Ω", "Δx", "Σ"]


def de_number():
    k = R.randrange(14)
    if k == 0:
        return str(R.randrange(0, 20))
    if k == 1:
        return str(R.randrange(20, 1000))
    if k == 2:
        n = R.randrange(1000, 10 ** 9)
        return f"{n:,}".replace(",", ".")
    if k == 3:
        return f"{R.randrange(0, 1000)},{R.randrange(0, 100):02d}"
    if k == 4:
        return f"-{R.randrange(1, 500)}"
    if k == 5:
        return f"{R.randrange(1, 40)}."
    if k == 6:
        return f"{R.randrange(0, 101)} %"
    if k == 7:
        return f"{R.randrange(1, 9999)},{R.randrange(0, 100):02d} €"
    if k == 8:
        return f"{R.randrange(1, 9)}/{R.randrange(2, 10)}"
    if k == 9:
        return f"{R.randrange(1, 50)}-{R.randrange(50, 100)}"
    if k == 10:
        return f"0{R.randrange(100, 999)} {R.randrange(100000, 9999999)}"
    if k == 11:
        return str(R.randrange(1000, 2100))
    if k == 12:
        return str(R.randrange(10 ** 9, 10 ** 15))
    return f"{R.randrange(0, 100)}.{R.randrange(0, 1000)}"


def de_date():
    d, m, y = R.randrange(1, 32), R.randrange(1, 13), R.randrange(1900, 2100)
    k = R.randrange(7)
    if k == 0:
        return f"{d}.{m}.{y}"
    if k == 1:
        return f"{d:02d}.{m:02d}.{y % 100:02d}"
    if k == 2:
        return f"{d}. {pick(DE_MONTHS)} {y}"
    if k == 3:
        return f"{y}-{m:02d}-{d:02d}"
    if k == 4:
        return f"{pick(['Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.', 'So.'])}, {d}. {pick(DE_MONTHS)}"
    if k == 5:
        return f"am {d}.{m}."
    return f"{d}.–{d + 2}. {pick(DE_MONTHS)}"


def de_time():
    h, mi, s = R.randrange(0, 24), R.randrange(0, 60), R.randrange(0, 60)
    k = R.randrange(6)
    if k == 0:
        return f"{h}:{mi:02d}"
    if k == 1:
        return f"{h:02d}:{mi:02d} Uhr"
    if k == 2:
        return f"{h}.{mi:02d} Uhr"
    if k == 3:
        return f"{h:02d}:{mi:02d}:{s:02d}"
    if k == 4:
        return f"um {h} Uhr"
    return f"{h}:{mi:02d}–{(h + 1) % 24}:{mi:02d} Uhr"


def de_simple():
    return f"{pick(DE_SUBJ)} {pick(DE_VERB)} {pick(DE_OBJ)} {pick(DE_ADV)}{pick(['.', '!', '?', '', '...', '…', '?!'])}"


def wrap_quote(s):
    a, b = pick(PUNCT_PAIRS)
    return f"{a}{s}{b}"


def de_entry(cat):
    if cat == "plain":
        return de_simple()
    if cat == "number":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} {de_number()} {pick(['Euro', 'Stück', 'Kilometer', 'Personen', 'Tage', 'mal', ''])} {pick(DE_ADV)}."
    if cat == "date":
        return f"Der Termin ist {de_date()}, {pick(DE_ADV)}."
    if cat == "time":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} {pick(DE_OBJ)} {de_time()}."
    if cat == "datetime":
        return f"Am {de_date()} um {de_time()} beginnt das {pick(DE_LOAN)}."
    if cat == "abbr":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} {pick(DE_ABBR)} {pick(DE_OBJ)} {pick(DE_ABBR)} {pick(DE_ADV)}."
    if cat == "umlaut":
        return f"{pick(DE_UMLAUT_WORDS)} und {pick(DE_UMLAUT_WORDS)} {pick(DE_VERB)} {pick(DE_UMLAUT_WORDS).lower()}."
    if cat == "compound":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} die {pick(DE_COMPOUNDS)} {pick(DE_ADV)}."
    if cat == "loan":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} das {pick(DE_LOAN)} und den {pick(DE_LOAN)} {pick(DE_ADV)}."
    if cat == "url":
        return f"Mehr Infos unter {pick(URLS)} oder {pick(URLS)}."
    if cat == "punct":
        parts = [de_simple().rstrip('.!?…') for _ in range(R.randrange(2, 5))]
        seps = [", ", "; ", ": ", " – ", " — ", " - ", "... ", "… ", " (", ") ", "! ", "? ", "?! ", " / ", " & "]
        s = parts[0]
        for p in parts[1:]:
            s += pick(seps) + p
        return wrap_quote(s) + pick([".", "!", "?", ""]) if R.random() < 0.5 else s + pick([".", "!!", "???", "…"])
    if cat == "emoji":
        s = de_simple()
        pos = R.randrange(3)
        e = "".join(pick(EMOJIS) for _ in range(R.randrange(1, 4)))
        return [e + " " + s, s + " " + e, s.replace(" ", " " + e + " ", 1)][pos]
    if cat == "symbol":
        return f"{pick(DE_SUBJ)} {pick(SYMBOLS)} {de_number()} {pick(SYMBOLS)}{pick(SYMBOLS)} {pick(DE_OBJ)}."
    if cat == "special":
        s = de_simple()
        words = s.split(" ")
        i = R.randrange(1, len(words))
        words.insert(i, pick(SPECIAL))
        return " ".join(words) if R.random() < 0.5 else pick(SPECIAL).join(words)
    if cat == "case":
        s = de_simple()
        return [s.upper(), s.lower(), s.title(), s.swapcase()][R.randrange(4)]
    if cat == "roman":
        return f"{pick(['Ludwig', 'Karl', 'Papst Johannes Paul', 'Kapitel', 'Band', 'Teil', 'Heinrich'])} {pick(['I', 'II', 'III', 'IV', 'V', 'VI', 'IX', 'XIV', 'XVI', 'XXI', 'MCMXCIX'])}{pick(['.', '', ','])} {pick(DE_VERB)} {pick(DE_OBJ)}."
    if cat == "long":
        n = R.randrange(8, 40)
        sep = pick([", ", " und ", " ", "; ", ", aber "])
        return sep.join(de_simple().rstrip(".!?…") for _ in range(n)) + "."
    if cat == "longword":
        return " ".join(pick(DE_COMPOUNDS) + pick(DE_COMPOUNDS).lower() for _ in range(R.randrange(1, 4)))
    if cat == "normalization":
        s = f"{pick(DE_UMLAUT_WORDS)} {de_simple()}"
        return unicodedata.normalize(pick(["NFD", "NFKD", "NFC", "NFKC"]), s)
    if cat == "foreign":
        return f"{pick(DE_SUBJ)} sagt {pick(FOREIGN_SCRIPTS)} {pick(DE_ADV)}."
    if cat == "polish":
        return f"{pick(DE_SUBJ)} {pick(DE_VERB)} {pick(DE_OBJ)} in {pick(POLISH)}, sagt {pick(POLISH)}."
    if cat == "mixed":
        return " ".join(de_entry(pick(["number", "date", "time", "abbr", "loan", "url", "emoji", "symbol"]))
                        for _ in range(R.randrange(2, 4)))
    raise ValueError(cat)


DE_REAL = [
    "Guten Tag, mein Name ist Anna Schmidt und ich rufe wegen meiner Rechnung vom 12. März an.",
    "Können Sie mir bitte sagen, wann der nächste Zug nach Hamburg fährt?",
    "Die Sitzung wurde auf Donnerstag, den 7. November 2024, 10:00 Uhr verschoben.",
    "Bitte überweisen Sie den Betrag von 1.249,99 € bis spätestens 31.12.2025.",
    "Ihre Kundennummer lautet 4711-0815-42.",
    "Wir haben täglich von 8 bis 18 Uhr geöffnet, samstags bis 14 Uhr.",
    "Das ist ja großartig!",
    "Hä? Was meinst du damit?",
    "Ähm, also, ich weiß nicht so recht …",
    "Mit freundlichen Grüßen, Ihr Kundenservice-Team.",
    "Die Temperatur liegt bei −5 °C, gefühlt eher bei −12 °C.",
    "Der Wagen fuhr mit 180 km/h über die A9.",
    "Er sagte: „Ich komme gleich wieder.“",
    "Sie fragte: »Hast du das gelesen?«",
    "Das kostet 3,50 EUR pro Stück bzw. 30 EUR für zehn Stück.",
    "Herzlichen Glückwunsch zum 50. Geburtstag!",
    "Paragraph § 823 Abs. 1 BGB regelt die Haftung.",
    "Die Firma Müller & Söhne GmbH & Co. KG wurde 1898 gegründet.",
    "Rufen Sie uns an unter +49 89 1234567 oder schreiben Sie an service@beispiel.de.",
    "Die Datei heißt Bericht_2024_final_v2.pdf.",
    "Ich hab’s dir doch gesagt!",
    "Wie geht’s? Gut, danke – und dir?",
    "Ein Drittel der Befragten (33,3 %) stimmte zu.",
    "Version 2.0.1 behebt 17 Fehler.",
    "Das WLAN-Passwort ist auf der Rückseite des Routers.",
    "Die ICE-Strecke Berlin–München ist ab 2025 schneller.",
    "Am 24.12. ist Heiligabend, am 31.12. Silvester.",
    "Der Ölpreis stieg um 2,3 Prozent auf 84,12 US-Dollar.",
    "Öffnen Sie bitte das Fenster.",
    "Übrigens: Äpfel sind gesünder als Süßigkeiten.",
]

# ---------------------------------------------------------------- English ---
EN_SUBJ = ["The customer", "Our team", "The company", "My mother", "The engineer", "A colleague", "The mayor",
           "The bus driver", "The child", "The teacher", "Mr. Smith", "Mrs. O'Brien", "The CEO", "The police",
           "My grandfather", "The bakery", "Dr. Jones", "St. Mary's Hospital", "The committee", "NASA"]
EN_VERB = ["pays", "orders", "checks", "postpones", "opens", "closes", "repairs", "recommends", "delivers",
           "cancels", "confirms", "forgets", "greets", "explains", "reads", "read", "leads", "led", "lives", "tears",
           "wind", "records", "presents", "permits", "conducts", "produces", "objects to", "minutes"]
EN_OBJ = ["the invoice", "the parcel", "the contract", "the size", "the breakfast", "the overview", "the key",
          "the street", "the football match", "the apples", "the cheese", "the oil", "the books", "the noise",
          "the fee", "the result", "the record", "the lead pipe", "the bass guitar", "the wound", "the tear"]
EN_ADV = ["today", "tomorrow morning", "next week", "at noon", "on time", "unfortunately not", "again",
          "maybe later", "extremely quickly", "rather late", "in London", "in New York", "at home", "in the office"]
EN_ABBR = ["e.g.", "i.e.", "etc.", "Dr.", "Prof.", "No.", "approx.", "Inc.", "Ltd.", "Corp.", "USA", "UK", "EU", "FBI",
           "NASA", "BBC", "mph", "km/h", "kg", "lbs", "°F", "°C", "%", "vs.", "Jan.", "Feb.", "Mon.", "a.m.", "p.m.",
           "St.", "Ave.", "Mt.", "Jr.", "Sr.", "Ph.D.", "ASAP", "FAQ", "DIY", "TV", "PIN", "ATM", "URL", "HTML", "JSON"]
EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
             "November", "December"]
EN_LOAN = ["café", "naïve", "résumé", "déjà vu", "kindergarten", "angst", "doppelgänger", "über", "fiancée",
           "jalapeño", "piñata", "façade", "coöperate", "Zeitgeist", "Wanderlust", "schadenfreude", "croissant", "sushi"]


def en_number():
    k = R.randrange(12)
    if k == 0:
        return str(R.randrange(0, 20))
    if k == 1:
        return str(R.randrange(20, 1000))
    if k == 2:
        return f"{R.randrange(1000, 10 ** 9):,}"
    if k == 3:
        return f"{R.randrange(0, 1000)}.{R.randrange(0, 100):02d}"
    if k == 4:
        return f"-{R.randrange(1, 500)}"
    if k == 5:
        n = R.randrange(1, 40)
        suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        return f"{n}{suf}"
    if k == 6:
        return f"{R.randrange(0, 101)}%"
    if k == 7:
        return f"${R.randrange(1, 9999)}.{R.randrange(0, 100):02d}"
    if k == 8:
        return f"{R.randrange(1, 9)}/{R.randrange(2, 10)}"
    if k == 9:
        return f"({R.randrange(200, 999)}) {R.randrange(200, 999)}-{R.randrange(1000, 9999)}"
    if k == 10:
        return str(R.randrange(1000, 2100))
    return f"£{R.randrange(1, 500)}"


def en_date():
    d, m, y = R.randrange(1, 29), R.randrange(1, 13), R.randrange(1900, 2100)
    k = R.randrange(5)
    if k == 0:
        return f"{m}/{d}/{y}"
    if k == 1:
        return f"{pick(EN_MONTHS)} {d}, {y}"
    if k == 2:
        return f"{d} {pick(EN_MONTHS)} {y}"
    if k == 3:
        return f"{y}-{m:02d}-{d:02d}"
    return f"the {d}th of {pick(EN_MONTHS)}"


def en_time():
    h, mi = R.randrange(1, 13), R.randrange(0, 60)
    k = R.randrange(4)
    if k == 0:
        return f"{h}:{mi:02d} {pick(['a.m.', 'p.m.', 'AM', 'PM', 'am', 'pm'])}"
    if k == 1:
        return f"{R.randrange(0, 24):02d}:{mi:02d}"
    if k == 2:
        return f"{h} o'clock"
    return f"at {h}:{mi:02d}"


def en_simple():
    return f"{pick(EN_SUBJ)} {pick(EN_VERB)} {pick(EN_OBJ)} {pick(EN_ADV)}{pick(['.', '!', '?', '', '...', '…'])}"


def en_entry(cat):
    if cat == "plain":
        return en_simple()
    if cat == "number":
        return f"{pick(EN_SUBJ)} {pick(EN_VERB)} {en_number()} {pick(['dollars', 'items', 'miles', 'people', 'days', 'times', ''])} {pick(EN_ADV)}."
    if cat == "date":
        return f"The appointment is on {en_date()}, {pick(EN_ADV)}."
    if cat == "time":
        return f"{pick(EN_SUBJ)} {pick(EN_VERB)} {pick(EN_OBJ)} {en_time()}."
    if cat == "abbr":
        return f"{pick(EN_SUBJ)} {pick(EN_VERB)} {pick(EN_ABBR)} {pick(EN_OBJ)} {pick(EN_ABBR)} {pick(EN_ADV)}."
    if cat == "loan":
        return f"{pick(EN_SUBJ)} {pick(EN_VERB)} the {pick(EN_LOAN)} and the {pick(EN_LOAN)}."
    if cat == "url":
        return f"Visit {pick(URLS)} or write to {pick(URLS)}."
    if cat == "punct":
        parts = [en_simple().rstrip('.!?…') for _ in range(R.randrange(2, 5))]
        seps = [", ", "; ", ": ", " – ", " — ", " - ", "... ", " (", ") ", "! ", "? ", " / ", " & "]
        s = parts[0]
        for p in parts[1:]:
            s += pick(seps) + p
        return wrap_quote(s) + pick([".", "!", "?", ""])
    if cat == "emoji":
        s = en_simple()
        e = "".join(pick(EMOJIS) for _ in range(R.randrange(1, 4)))
        return [e + " " + s, s + " " + e, s.replace(" ", " " + e + " ", 1)][R.randrange(3)]
    if cat == "symbol":
        return f"{pick(EN_SUBJ)} {pick(SYMBOLS)} {en_number()} {pick(SYMBOLS)} {pick(EN_OBJ)}."
    if cat == "special":
        words = en_simple().split(" ")
        words.insert(R.randrange(1, len(words)), pick(SPECIAL))
        return " ".join(words)
    if cat == "case":
        s = en_simple()
        return [s.upper(), s.lower(), s.title(), s.swapcase()][R.randrange(4)]
    if cat == "long":
        n = R.randrange(8, 40)
        return pick([", ", " and ", " ", "; "]).join(en_simple().rstrip(".!?…") for _ in range(n)) + "."
    if cat == "contraction":
        return pick(["I'm", "you're", "it's", "can't", "won't", "shouldn't've", "y'all", "o'clock", "rock'n'roll",
                     "don’t", "isn’t", "we’ll", "'til", "'90s", "the 1990s", "James's", "Chris'"]) + " " + en_simple()
    if cat == "foreign":
        return f"{pick(EN_SUBJ)} says {pick(FOREIGN_SCRIPTS)} {pick(EN_ADV)}."
    if cat == "polish":
        return f"{pick(EN_SUBJ)} {pick(EN_VERB)} {pick(EN_OBJ)} in {pick(POLISH)}."
    if cat == "normalization":
        return unicodedata.normalize(pick(["NFD", "NFKD"]), f"{pick(EN_LOAN)} {en_simple()}")
    if cat == "mixed":
        return " ".join(en_entry(pick(["number", "date", "time", "abbr", "url", "emoji", "symbol"])) for _ in range(R.randrange(2, 4)))
    raise ValueError(cat)


EN_REAL = [
    "Hello, my name is John and I'm calling about my invoice from March 12th.",
    "Could you please tell me when the next train to Boston leaves?",
    "The meeting has been moved to Thursday, November 7, 2024, at 10:00 a.m.",
    "Please transfer $1,249.99 by December 31, 2025.",
    "Your customer number is 4711-0815-42.",
    "We're open daily from 8 a.m. to 6 p.m., Saturdays until 2 p.m.",
    "That's absolutely fantastic!",
    "Wait, what do you mean?",
    "Um, well, I'm not really sure…",
    "He said, \"I'll be right back.\"",
    "The temperature is -5 °F, feels like -20.",
    "The read-only file was read by the reader who reads a lot.",
    "I live near the live music venue.",
    "The wind will wind down by evening.",
    "Version 2.0.1 fixes 17 bugs.",
    "Call us at +1 (555) 123-4567 or e-mail support@example.com.",
    "The C++ and C# developers met at 9:30.",
    "Dr. Smith lives on Elm St. near St. Paul's Cathedral.",
    "The U.S. economy grew 2.3% in Q3.",
    "I'd've done it if I could've.",
]

EDGE_COMMON = ["", " ", "  ", "\t", "\n", "\r\n", "\u00a0", "\u3000", ".", "...", "…", "!", "?", ",", ";", ":", "-", "–", "—",
               "\"", "„“", "()", "[]", "{}", "'", "’", "a", "A", "B", "x", "Z", "1", "0", "42", "007", "1.", "1,5", "-0",
               "€", "$", "%", "&", "@", "#", "*", "😀", "👍🏽", "🇩🇪", "\u200b", "\u00ad", "\ufeff", "\u0000",
               "abc\u0000def", "\u0301", "e\u0301", "ﬁ", "Ｆｕｌｌｗｉｄｔｈ", "²", "½", "™", "§ 1", "ẞ", "ß", "SS",
               "\u2028", "\u0085", "\x1c\x1d", "\x7f", "\x01\x02\x03", "a\tb\nc", "  leading and trailing  ",
               "Mehrere   Leerzeichen   hier", "Zeile eins\nZeile zwei\n\nZeile vier", "Wort-", "-Wort", "Bindestrich-Wort",
               "Wort/Wort", "Wort.Wort", "Wort,Wort", "Wort!Wort", "(Klammer)", "[eckig]", "{geschweift}", "«Guillemets»",
               "…und weiter", "Ende…", "?!?!", "!!!", "???", ". . .", "1 2 3 4 5 6 7 8 9 10", "I II III IV",
               "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "ä" * 300, "x" * 1000,
               "Satz. " * 200, ", ".join(["Wort"] * 400), " ".join(str(i) for i in range(300)),
               "[[ˈhalo]]", "[[h@'lo:]]", "<speak>Hallo</speak>", "&amp; &lt; &gt;", "\\n", "%s %d", "{0}", "${x}"]


def build():
    de, en = [], []
    de_cats = {"plain": 250, "number": 300, "date": 200, "time": 150, "datetime": 100, "abbr": 250, "umlaut": 150,
               "compound": 150, "loan": 200, "url": 100, "punct": 250, "emoji": 120, "symbol": 100, "special": 120,
               "case": 80, "roman": 60, "long": 60, "longword": 30, "normalization": 80, "foreign": 60, "polish": 60, "mixed": 120}
    for cat, n in de_cats.items():
        for _ in range(n):
            de.append((cat, de_entry(cat)))
    for s in DE_REAL:
        de.append(("real", s))
    en_cats = {"plain": 150, "number": 180, "date": 100, "time": 80, "abbr": 150, "loan": 60, "url": 60, "punct": 150,
               "emoji": 70, "symbol": 60, "special": 70, "case": 50, "long": 40, "contraction": 80, "foreign": 40, "polish": 30,
               "normalization": 40, "mixed": 80}
    for cat, n in en_cats.items():
        for _ in range(n):
            en.append((cat, en_entry(cat)))
    for s in EN_REAL:
        en.append(("real", s))
    for s in EDGE_COMMON:
        de.append(("edge", s))
        en.append(("edge", s))
    # shuffle deterministically so that stateful effects between sentences are exercised across categories
    R.shuffle(de)
    R.shuffle(en)
    mk = lambda lang, items: [{"id": f"{lang}-{i:05d}", "cat": c, "text": t} for i, (c, t) in enumerate(items)]
    return {"de": mk("de", de), "en": mk("en", en)}


if __name__ == "__main__":
    corpus = build()
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(corpus, f, ensure_ascii=False, indent=0)
    print({k: len(v) for k, v in corpus.items()})

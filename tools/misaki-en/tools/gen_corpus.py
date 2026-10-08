"""Generate the English parity corpus (deterministic).

    python tools/gen_corpus.py test/corpus/en_corpus.json

Sources:
  1. handwritten sentences (all categories of the task)
  2. templates (numbers, money, dates, times, units, versions, code terms ...)
  3. natural technical English sentences taken from docstrings of the Python
     standard library (PSF license; test data only, not shipped)
  4. long paragraphs (> 510 phonemes) and multi-line texts for chunking
"""
import json
import random
import re
import sys

rnd = random.Random(20261008)

HAND = r"""
Hello, how are you doing today?
I can't believe it's already October.
We'll meet at the station around noon, won't we?
She didn't say whether he'd arrive before dinner.
They're going to read the report tomorrow; I read it yesterday.
Please read the instructions carefully before you begin.
I have read every book on that shelf.
The lead singer was poisoned by lead in the water pipes.
They will lead the team to victory.
We live in a small town near the coast.
The band played a live concert last night.
Watch the live stream on our website.
She wants to record a new album next year.
That was a world record for the hundred meters.
The record shows that he was present.
Can you record this meeting for me?
The wind was so strong that we couldn't wind the sail.
Wind the clock before you go to bed.
He wound the bandage around the wound.
The bandage was wound around the wound.
I object to that object being placed here.
Please present the present to the winner.
The present situation requires a quick decision.
They refuse to collect the refuse on Sundays.
The dove dove into the bushes.
The farm was used to produce produce.
A bass was painted on the head of the bass drum.
When shot at, the dove dove into the bushes.
I did not desert my friend in the desert.
The insurance was invalid for the invalid.
There was a row among the oarsmen about how to row.
They were too close to the door to close it.
The buck does funny things when the does are present.
A seamstress and a sewer fell down into a sewer line.
To help with planting, the farmer taught his sow to sow.
The soldier decided to desert his dessert in the desert.
After a number of injections my jaw got number.
Upon seeing the tear in the painting I shed a tear.
I had to subject the subject to a series of tests.
How can I intimate this to my most intimate friend?
We must polish the Polish furniture.
He could lead if he would get the lead out.
The content of the letter made her content.
Excuse me, but there is no excuse for that.
Does he use the same excuse every time?
I used to live in Berlin.
This phone is used every day.
The used car was cheaper than expected.
He's used to working late.
You are going to love this.
It's time to go to the store.
I want to eat an apple and an orange.
I am here, and you are there.
Am I right or am I wrong?
I'd like a cup of tea, please.
You shouldn't have done that!
Wouldn't it be nice if we could fly?
Y'all should've seen the look on his face.
It's not what you think; it's what you do.
Who's there? It's me!
Let's go, let's go, let's go!
That's the dog's bone, not the cat's.
The students' projects were impressive.
James's car is parked outside.
The children's playground is closed.
I ain't got no time for this.
Ma'am, your table is ready.
Rock 'n' roll will never die.
Twas the night before Christmas.
O'Brien and O'Neill went to the pub.
The well-known author wrote a long-term plan.
My mother-in-law is a self-employed graphic designer.
It was a state-of-the-art, up-to-date, ready-to-use solution.
This is a high-quality, low-cost, easy-to-use product.
He's a twenty-five-year-old software engineer.
We need a follow-up meeting next week.
The re-entry of the spacecraft was a nail-biting moment.
She gave a thumbs-up and a half-hearted smile.
Wait... what did you just say?
Really?! I had no idea!
Well, um, I guess so... maybe.
"Hello," she said, "how are you?"
He said, 'I'll be back.'
The so-called "expert" didn't know anything.
The answer is (as always) forty-two.
Use semicolons; they're useful sometimes.
Note: this is important.
Warning! Do not touch the red button.
Section 3.2 describes the method in detail.
Hmm, that's interesting.
Oh no! I forgot my keys again.
Wow, that was amazing!
Yes. No. Maybe.
Okay, okay, I get it.
OK, let's begin.
The CEO of NASA met the president of the FBI.
The USA, the UK and the EU signed the agreement.
I work at IBM and my friend works at AT&T.
The BBC reported that the UN was meeting in NYC.
Send it ASAP, please.
FYI, the meeting is at 10 a.m.
The ETA is about 3 p.m.
He has a Ph.D. in physics from MIT.
Mr. and Mrs. Smith live on Main St. near Dr. Brown's office.
Prof. Johnson and Sen. Williams spoke at the event.
St. Louis is a city in Missouri.
Washington, D.C. is the capital of the U.S.
The U.S. Army and the U.K. Navy held joint exercises.
I.e., you need to pay before you leave.
E.g., apples, oranges, etc.
We compared iOS vs. Android performance.
It's Apple vs Google in court again.
Use HTML, CSS and JavaScript for the frontend.
The API returns JSON over HTTPS.
Our SQL database runs on PostgreSQL.
The GPU has 24 GB of VRAM.
My CPU is an Intel Core i7.
I bought a new USB-C cable and an HDMI adapter.
The PDF file is attached to the email.
Download the ZIP archive and extract it.
The URL is https://www.example.com/docs/index.html.
Email me at john.doe@example.com for details.
Visit www.wikipedia.org for more information.
Follow us on Twitter @OpenAI and #AI.
Check out github.com/hexgrad/kokoro for the code.
Run npm install and then npm run build.
Use git commit -m "fix bug" to save changes.
Call the function getUserById() with an integer.
The variable user_name stores the login.
Set MAX_RETRIES to 5 in config.yaml.
The class HttpRequestHandler extends BaseHandler.
Import numpy as np and pandas as pd.
Run python3 -m venv .venv to create an environment.
Open localhost:8080 in your browser.
The file is located at /usr/local/bin/python3.
Edit C:\Users\Admin\Documents\notes.txt on Windows.
Use the --verbose flag for more output.
Press Ctrl+C to stop the server.
The function returns null if the key is missing.
This is a camelCase variable and that is snake_case.
Kubernetes pods are scheduled on nodes.
Docker containers share the host kernel.
The React component re-renders when state changes.
TypeScript adds static types to JavaScript.
Node.js 22 supports ES modules natively.
I use VS Code with the ESLint extension.
The regex ^[a-z]+$ matches lowercase words.
Version 2.0.1 fixed the memory leak in v1.9.
Python 3.12 was released in October 2023.
Our app runs on iOS 17 and Android 14.
The WiFi password is printed on the router.
My IP address is 192.168.1.1.
Ping 8.8.8.8 to check the connection.
The server responded with HTTP 404 Not Found.
Error code 0x80070005 means access denied.
The SHA-256 hash is a long hexadecimal string.
Machine learning models need a lot of data.
The LLM generated a summary of the article.
Kokoro is a text-to-speech model with 82 million parameters.
The TTS engine converts text into natural-sounding speech.
Use UTF-8 encoding for all text files.
The meeting is scheduled for Monday, January 15th.
She was born on July 4, 1990.
The deadline is 2024-03-31.
We met on 12/25/2023 for Christmas dinner.
The event runs from 9:00 to 17:30.
Call me at 7:45 tomorrow morning.
It's 11:59 PM on New Year's Eve.
The train leaves at 6 o'clock sharp.
The year 1999 was a long time ago.
In 2000 the world didn't end.
The 1980s were full of great music.
The 21st century began in 2001.
World War II ended in 1945.
The Roman Empire fell in 476 AD.
Shakespeare was born in 1564.
The Moon landing happened in 1969.
Queen Elizabeth II reigned for 70 years.
Pope John Paul II visited Poland.
Henry VIII had six wives.
Chapter IV begins on page 112.
It costs $5.
It costs $5.99 plus tax.
The ticket was £20 and the drink €3.50.
I paid $1,250.00 for the laptop.
The house sold for $1.2 million.
Bitcoin hit $60,000 last year.
That's only 99 cents!
He earns $75k a year.
The budget is $3 billion.
I owe you $0.50.
Gas costs $3.49 per gallon.
The temperature is 72°F today.
It's -5 degrees outside.
Water boils at 100 °C.
The car goes 0 to 60 mph in 4.2 seconds.
The box weighs 2.5 kg.
He ran 10km in 45 minutes.
Add 250ml of milk and 2 tbsp of sugar.
The screen is 15.6 inches wide.
The file is 3.5 MB.
Download speed is 100 Mbps.
I'm 6'2" tall.
The odds are 3 to 1.
The score was 3-2 in overtime.
The ratio is 16:9.
Sales grew by 15% in Q2.
Only 0.5% of users reported the bug.
Interest rates rose to 5.25 percent.
The population is 8,000,000,000 people.
The answer is 42.
One, two, three, four, five.
1, 2, 3, go!
He finished 1st, she finished 2nd and I finished 3rd.
This is the 100th time I've told you.
The 4th of July is a holiday.
Room 101 is on the 1st floor.
Flight 370 departs from gate 23.
Call 911 in an emergency.
My number is 555-123-4567.
The ZIP code is 90210.
Agent 007 is on a mission.
The code is 1234.
PIN 0000 is not secure.
Pi is approximately 3.14159.
The value of e is about 2.71828.
Multiply 12 by 12 to get 144.
7 + 8 = 15 and 9 - 4 = 5.
2^10 equals 1024.
The fraction 3/4 is the same as 0.75.
Half of 1/2 is 1/4.
The 2nd and 3rd quarters were strong.
I need 2 of those and 3 of these.
I'll be there in 5 minutes.
He scored 98.6 on the test.
The 5G network is fast.
I love my iPhone 15 Pro Max.
The Boeing 747 is a jumbo jet.
COVID-19 changed the world.
The F-35 is a fighter jet.
Area 51 is in Nevada.
The PS5 and Xbox Series X are consoles.
B2B companies sell to other businesses.
Let's talk peer-to-peer and face2face.
I'll see you l8r.
John Smith met Mary Johnson in Paris.
Barack Obama was the 44th president.
Elon Musk founded SpaceX and Tesla.
Angela Merkel was Germany's chancellor.
Satya Nadella leads Microsoft.
Hermione Granger is a character in Harry Potter.
Sherlock Holmes lives at 221B Baker Street.
Frodo carried the ring to Mordor.
Tokyo, Beijing and Seoul are Asian capitals.
I flew from San Francisco to Los Angeles.
The Mississippi River flows into the Gulf of Mexico.
Mount Everest is the highest mountain.
Zurich, Munich and Vienna are lovely cities.
Siobhan and Niamh are Irish names.
Nguyen is a common Vietnamese surname.
Tchaikovsky composed Swan Lake.
Nietzsche and Schopenhauer were German philosophers.
Dvořák wrote the New World Symphony.
I had a croissant at the café.
The naïve résumé was rejected.
She wore a beautiful fiancée ring.
The jalapeño salsa was spicy.
Façade and coöperate use diacritics.
Übermensch is a German word.
I love emojis 😀😂🎉!
Great job 👍
Happy birthday 🎂🎈🎁
I ❤️ New York.
The weather is ☀️ today, but tomorrow 🌧️.
Let's go 🚀🚀🚀
Thanks 🙏 for your help!
That's 🔥🔥
Check ✅ and cross ❌.
Smiley :) and sad :( faces.
I <3 you.
Wink ;) wink.
**Bold text** and *italic text* in markdown.
# Heading One
## Getting Started
- First item in the list
* Another bullet point
1. Install the package
> This is a quoted line.
Use `npm install` to install dependencies.
```python print("hello") ```
See the [documentation](https://example.com/docs) for details.
Click [here](http://example.com) to continue.
[Kokoro](/kˈOkəɹO/) is an open-weight TTS model.
I love [Misaki](/misˈɑki/) so much.
The word [read](/ɹˈɛd/) is in past tense here.
This is [really](+2) important.
That is [not](-1) what I meant.
Say [hello](0.5) to everyone.
[One](#a#) hundred and twenty.
| Name | Age | City |
---
Visit the ~~old~~ new website.
Line one.\nLine two.\n\nLine three after a blank line.
The quick brown fox jumps over the lazy dog.
THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG.
the quick brown fox jumps over the lazy dog
ThE qUiCk BrOwN fOx JuMpS oVeR tHe LaZy DoG.
STOP! DON'T MOVE!
This is VERY important.
I said NO, and I MEANT it.
WARNING: HIGH VOLTAGE.
The README file explains everything.
Read the FAQ before asking.
NASA's Artemis program aims for the Moon.
The WHO declared a pandemic.
UNESCO protects world heritage sites.
LOL, that's so funny.
OMG, did you see that?
BTW, I'm leaving early.
IMHO, this is the best option.
TBH I don't care.
The DIY project took all weekend.
We need an MVP by Q3.
The KPI dashboard shows ROI and CTR.
Our SaaS product has an SLA of 99.9%.
The IPO raised $2B.
GDP and CPI figures were released.
The ATM was out of cash.
I need a VPN for my PC.
The NFL and NBA seasons overlap.
The MRI scan showed nothing unusual.
DNA and RNA are nucleic acids.
The pH of water is 7.
H2O is water and CO2 is carbon dioxide.
E=mc2 is Einstein's famous equation.
The Wi-Fi network is called HomeNet_5G.
Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Supercalifragilisticexpialidocious is a long word.
Pneumonoultramicroscopicsilicovolcanoconiosis is even longer.
Antidisestablishmentarianism was a political position.
Floccinaucinihilipilification means estimating as worthless.
I googled it and then I zoomed into the meeting.
She photoshopped the picture before tweeting it.
Let's whatsapp later and facetime tonight.
They're unfriending people on Facebook.
I'm binge-watching Netflix all weekend.
The selfie went viral on Instagram.
He's a YouTuber with a million subscribers.
Uber and Lyft compete for drivers.
Spotify recommended a new playlist.
Airbnb hosts earn extra income.
Cryptocurrency and blockchain are buzzwords.
The metaverse is a virtual world.
Unbelievable! Absolutely incredible!
Nevertheless, we persisted.
Consequently, the plan was abandoned.
Furthermore, the results were inconclusive.
In conclusion, more research is needed.
On the other hand, it might work.
To be or not to be, that is the question.
All that glitters is not gold.
A journey of a thousand miles begins with a single step.
The early bird catches the worm.
Actions speak louder than words.
Better late than never.
Don't count your chickens before they hatch.
Every cloud has a silver lining.
Ask not what your country can do for you.
I have a dream that one day this nation will rise up.
Four score and seven years ago our fathers brought forth on this continent a new nation.
It was the best of times, it was the worst of times.
Call me Ishmael.
In a hole in the ground there lived a hobbit.
It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife.
The sky above the port was the color of television, tuned to a dead channel.
He wasn't sure whether to laugh or cry.
They've been working on this project for years.
You'd better hurry up, or you'll miss the bus.
I'm sorry, but I can't help you with that.
Could you please pass the salt?
Would you mind closing the window?
May I ask you a question?
Shall we dance?
What time is it?
Where are you from?
Why is the sky blue?
How much does it cost?
Which one do you prefer?
Whose book is this?
When does the store open?
Who wrote this letter?
The cat sat on the mat.
The dog barked at the mailman.
Birds fly south for the winter.
Fish swim in the ocean.
The sun rises in the east.
It's raining cats and dogs.
I'm feeling under the weather.
Break a leg tonight!
That's a piece of cake.
Let the cat out of the bag.
The ball is in your court.
We'll cross that bridge when we come to it.
Cut to the chase, please.
Hit the nail on the head.
Once in a blue moon.
Kill two birds with one stone.
I need to buy milk, eggs, bread, butter, cheese, and coffee.
First, preheat the oven to 350 degrees.
Then, mix the flour, sugar, and eggs in a bowl.
Finally, bake for 25 to 30 minutes.
Turn left at the second traffic light.
Go straight for two blocks and turn right.
The museum is open from Tuesday to Sunday.
Tickets are available online or at the door.
Children under 12 enter for free.
Please keep your seatbelt fastened.
The next stop is Central Station.
Mind the gap between the train and the platform.
Your call is important to us.
Please hold while we connect you.
Press 1 for English, press 2 for Spanish.
Your order has been shipped.
Your package will arrive on Thursday.
Thank you for shopping with us!
Your password must contain at least 8 characters.
Please enter a valid email address.
Are you sure you want to delete this file?
The operation completed successfully.
An unexpected error occurred. Please try again later.
No results found for your search.
Loading, please wait...
Do you want to save changes before closing?
You have 3 unread messages.
Battery low: 15% remaining.
Update available: version 4.2.0.
Connection lost. Reconnecting...
Sign in with Google or Apple.
Two-factor authentication is enabled.
Your session has expired.
The project is 75% complete.
Deploy to production on Friday? Never!
The build failed because of a missing semicolon.
Fix the off-by-one error in the loop.
The unit tests pass but the integration tests fail.
Refactor the legacy code before adding features.
We use CI/CD pipelines with GitHub Actions.
The PR was merged into the main branch.
Please review my pull request.
The stack trace points to line 42.
Memory usage spiked to 95% during the load test.
The latency dropped from 200ms to 50ms.
The cache hit rate is 87.5%.
We scaled the cluster to 16 nodes.
The microservice talks to Redis and Kafka.
The frontend is built with Vue and Vite.
Rust guarantees memory safety without garbage collection.
Go routines are lightweight threads.
Java and Kotlin run on the JVM.
C++ templates can be tricky.
C# is popular for game development with Unity.
Swift and Objective-C are used for iOS apps.
PHP powers WordPress.
Ruby on Rails popularized convention over configuration.
Haskell is a purely functional language.
SQL injection is a common vulnerability.
Use HTTPS and TLS 1.3 everywhere.
OAuth 2.0 handles authorization.
JWT tokens should expire quickly.
The SSH key was added to the server.
Backup your data regularly.
The RAID array has two failed disks.
Linux, macOS and Windows are operating systems.
Ubuntu 22.04 LTS is stable.
The kernel panic happened at boot.
Open the terminal and type ls -la.
Use sudo apt-get update to refresh packages.
The cron job runs every 5 minutes.
Set the env variable NODE_ENV=production.
The JSON object has keys "id", "name" and "email".
The array index starts at 0.
A for-loop iterates over the list.
The if-else statement checks the condition.
Recursion requires a base case.
Big O notation describes complexity: O(n log n).
The hash map has O(1) lookups.
Binary search runs in O(log n) time.
Dijkstra's algorithm finds shortest paths.
Neural networks have layers of neurons.
The transformer architecture uses attention.
GPT-4 and Claude are large language models.
The model has 7B parameters and runs on a single GPU.
Fine-tuning with LoRA reduces memory usage.
The dataset contains 1.5M examples.
Accuracy improved from 89.3% to 92.1%.
The learning rate was set to 3e-4.
Batch size 32, epochs 10, dropout 0.1.
RLHF aligns models with human preferences.
The F1 score is the harmonic mean of precision and recall.
"""

ADJ = ['happy', 'quick', 'lazy', 'bright', 'quiet', 'loud', 'ancient', 'modern', 'fragile', 'enormous']
NOUN = ['dog', 'computer', 'teacher', 'river', 'city', 'garden', 'engineer', 'project', 'violin', 'database']
VERBED = ['walked', 'jumped', 'called', 'fixed', 'painted', 'tested', 'deployed', 'refactored', 'debugged', 'visited']
NAMES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fatima', 'Giovanni', 'Hiroshi', 'Isabella', 'Jamal',
         'Katarzyna', 'Liam', 'Mohammed', 'Nadia', 'Oliver', 'Priya', 'Quentin', 'Rosa', 'Sven', 'Tatiana',
         'Ulrich', 'Valentina', 'Wei', 'Xavier', 'Yusuf', 'Zoe', 'McDonald', 'MacArthur', "O'Connor", 'DeShawn']
PLACES = ['London', 'Berlin', 'New York', 'Tokyo', 'Sydney', 'Toronto', 'Mumbai', 'Cairo', 'Rio de Janeiro',
          'Reykjavik', 'Kyiv', 'Wellington', 'Nairobi', 'Lisbon', 'Seattle', 'Boston', 'Chicago', 'Austin']
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
          'November', 'December', 'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Mon', 'Fri']
UNITS = ['km', 'kg', 'cm', 'mm', 'mph', 'GB', 'MB', 'TB', 'ms', 'ml', 'lbs', 'oz', 'ft', 'm', '%', 'K', 'kHz', 'GHz']
CODE = ['useEffect', 'setTimeout', 'async/await', 'XMLHttpRequest', 'innerHTML', 'getElementById', 'parseInt',
        'toString()', 'len(x)', 'self.__init__', '__main__', 'package.json', 'tsconfig.json', '.gitignore', 'Dockerfile',
        'README.md', 'main.py', 'index.ts', 'utils/helpers.js', 'src/app/page.tsx', 'kebab-case', 'PascalCase',
        'SCREAMING_SNAKE_CASE', 'HTTPServer', 'IOError', 'NullPointerException', 'std::vector<int>', 'Array.prototype.map',
        'Promise.all', 'npm', 'npx', 'pnpm', 'pip', 'conda', 'brew', 'kubectl', 'terraform', 'ffmpeg', 'curl', 'wget',
        'grep', 'awk', 'sed', 'chmod +x', 'rm -rf', 'git rebase -i', 'localhost:3000', '127.0.0.1', 'v8', 'WebAssembly',
        'GraphQL', 'gRPC', 'REST', 'CRUD', 'ORM', 'JSONB', 'UUID', 'SHA1', 'base64', 'utf-8', 'x86_64', 'arm64', 'ARMv8',
        'IPv6', 'macOS', 'iPadOS', 'watchOS', 'tvOS', 'eBay', 'iPod', 'YouTube', 'LinkedIn', 'GitHub', 'GitLab', 'OpenAI',
        'DeepMind', 'PyTorch', 'TensorFlow', 'NumPy', 'SciPy', 'scikit-learn', 'Matplotlib', 'pandas', 'FastAPI', 'Django',
        'Next.js', 'Nuxt', 'SvelteKit', 'Tailwind', 'PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'DynamoDB', 'S3', 'EC2',
        'Lambda', 'k8s', 'i18n', 'a11y', 'l10n', 'OAuth2', 'WebRTC', 'WebSocket', 'HTTP/2', 'HTTP/3', 'QUIC', 'TCP/IP']
ABBR = ['Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Jr.', 'Sr.', 'St.', 'Ave.', 'Inc.', 'Ltd.', 'Corp.', 'Co.', 'etc.', 'approx.',
        'dept.', 'est.', 'vs.', 'e.g.', 'i.e.', 'a.m.', 'p.m.', 'No.', 'Fig.', 'Vol.', 'pp.', 'Gen.', 'Lt.', 'Capt.', 'Rev.']
ACRO = ['NASA', 'FBI', 'CIA', 'NATO', 'UNICEF', 'HTML', 'CSS', 'API', 'SDK', 'CLI', 'GUI', 'IDE', 'RAM', 'ROM', 'SSD',
        'HDD', 'LED', 'LCD', 'OLED', 'USB', 'PDF', 'JPEG', 'PNG', 'GIF', 'MP3', 'MP4', 'AI', 'ML', 'NLP', 'TTS', 'ASR',
        'OCR', 'IoT', 'AR', 'VR', 'XR', 'CEO', 'CTO', 'CFO', 'HR', 'PR', 'QA', 'UX', 'UI', 'B2C', 'P2P', 'DIY', 'FAQ',
        'ETA', 'RSVP', 'ASAP', 'AWOL', 'SCUBA', 'LASER', 'RADAR', 'GIF', 'JPEG', 'SQL', 'GNU', 'WYSIWYG']
HOMO = [
    ('read', ['I {w} books every night.', 'Yesterday I {w} three chapters.', 'Have you {w} it?', 'Please {w} aloud.']),
    ('live', ['Where do you {w}?', 'The show is {w} tonight.', 'These are {w} wires!', 'I {w} for music.']),
    ('lead', ['Who will {w} the meeting?', 'The pipe was made of {w}.', 'She took the {w} in the race.', 'Get the {w} out!']),
    ('record', ['Press {w} to start.', 'We {w} every call.', 'That is a new {w}.', 'Did you {w} the show?']),
    ('close', ['Please {w} the door.', 'We are very {w} friends.', 'The store will {w} soon.', 'That was a {w} call.']),
    ('wind', ['The {w} is cold.', 'Do not {w} the watch too tight.', 'A strong {w} blew.', 'They {w} the yarn.']),
    ('tear', ['A {w} rolled down her cheek.', 'Do not {w} the paper.', 'There is a {w} in my jeans.']),
    ('bow', ['Take a {w} after the show.', 'She tied a red {w}.', 'The {w} of the ship.', 'He shot an arrow from his {w}.']),
    ('minute', ['Wait a {w}.', 'The differences are {w}.', 'Give me one {w}.']),
    ('object', ['I {w} to that.', 'What is that {w}?', 'They {w} strongly.']),
    ('present', ['I will {w} the plan.', 'Here is your {w}.', 'Everyone is {w}.']),
    ('produce', ['Farms {w} food.', 'Buy fresh {w} at the market.']),
    ('content', ['I am {w} with this.', 'The {w} is great.']),
    ('desert', ['The {w} is hot.', 'Do not {w} your post.']),
    ('use', ['What is the {w} of this?', 'I {w} it every day.']),
    ('house', ['They {w} the refugees.', 'The {w} is big.']),
    ('wound', ['He {w} the clock.', 'The {w} healed slowly.']),
    ('bass', ['He plays the {w} guitar.', 'We caught a large {w}.']),
    ('row', ['Sit in the front {w}.', 'They had a terrible {w}.', 'Let us {w} the boat.']),
    ('sow', ['They {w} seeds in spring.', 'The {w} had piglets.']),
    ('polish', ['Please {w} my shoes.', 'He speaks {w} fluently.']),
    ('August', ['I travel in {w}.', 'An {w} gathering of scholars.']),
    ('refuse', ['I {w} to go.', 'Take out the {w}.']),
    ('permit', ['You need a {w}.', 'We cannot {w} that.']),
    ('project', ['The {w} is late.', 'They {w} growth of 10%.']),
    ('conduct', ['His {w} was poor.', 'They {w} experiments.']),
    ('increase', ['An {w} in price.', 'We will {w} the budget.']),
    ('perfect', ['A {w} day.', 'They {w} the recipe.']),
    ('used', ['I {w} to smoke.', 'It is {w} daily.', 'A {w} car.']),
    ('lives', ['She {w} here.', 'Cats have nine {w}.']),
    ('reads', ['He {w} a lot.']),
    ('leads', ['She {w} the team.', 'The detective followed the {w}.']),
    ('does', ['He {w} not care.', 'The {w} and bucks grazed.']),
]


def numbers():
    out = []
    ints = [0, 1, 7, 10, 12, 13, 19, 20, 21, 42, 99, 100, 101, 110, 115, 200, 250, 999, 1000, 1001, 1010, 1100,
            1200, 1500, 1999, 2000, 2001, 2010, 2024, 2100, 3000, 9999, 10000, 12345, 99999, 100000, 123456,
            1000000, 1234567, 10000000, 999999999, 1000000000, 1234567890, 10 ** 12, 31415926535, 10 ** 15 + 7]
    for n in ints:
        out.append(f'The number is {n}.')
        out.append(f'We counted {n:,} votes.')
    for n in [1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 31, 42, 100, 101, 111, 112, 1000, 2023]:
        suf = 'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
        out.append(f'This is the {n}{suf} attempt.')
    for f in ['0.5', '1.25', '3.14', '2.718', '0.001', '10.10', '99.99', '1.0', '100.5', '0.0', '.5', '.75', '12.345',
              '1,234.56', '3.0', '0.07', '4.20', '6.022', '1.50', '1.05']:
        out.append(f'The value is {f} today.')
    for v in ['1.2.3', '10.0.1', '3.11.4', '192.168.0.1', '2.0', 'v1.2', 'v2.3.4', '4.0.0-beta', '1.0.0-rc.1']:
        out.append(f'Upgrade to version {v} now.')
    for n in ['-1', '-42', '-3.5', '-100', '-0.5', '+5', '+1-555-0100']:
        out.append(f'The result was {n} after the test.')
    for y in [1066, 1492, 1776, 1800, 1801, 1905, 1984, 2000, 2007, 2019, 2030, 1000, 1100, 1010, 900, 2100]:
        out.append(f'It happened in {y}.')
        out.append(f'Back in the {y}s things were different.')
    for n in ['1990s', "1990's", '80s', "'90s", '20s', '1st', '22nd', '33rd', '104th', '3D', '4K', '8K', '2FA', '3x',
              '10x', '24/7', '50/50', '1/3', '2/3', '3/8', '9/11', '20/20', '1:1', '4:3', '100k', '5M', '2B', '1.5x']:
        out.append(f'We talked about {n} for a while.')
    return out


def money():
    out = []
    for a in ['$1', '$1.00', '$0.01', '$0.99', '$2', '$10', '$10.50', '$100', '$1,000', '$1,000,000', '$5.5',
              '$12.345', '$3.50', '$20.00', '$1.01', '£1', '£5', '£2.50', '£0.30', '£100', '€1', '€9.99', '€15',
              '€1,200', '€0.50', '¥1000', '₹500', 'USD 50', '50 USD', '20 EUR', '$5M', '$2.5B', '$10k', '$1.99/month',
              '$-5', '$ 20', '30$', '5 dollars', '25 cents', 'twelve bucks']:
        out.append(f'It costs {a} in total.')
        out.append(f'{a} is too much for me.')
    return out


def dates_times():
    out = []
    for i in range(60):
        m = rnd.choice(MONTHS)
        d = rnd.randint(1, 31)
        y = rnd.choice([1999, 2001, 2015, 2023, 2024, 2025, 2026, 1987, 1850])
        out.append(rnd.choice([
            f'The meeting is on {m} {d}, {y}.',
            f'See you on {rnd.choice(DAYS)}, {m} {d}.',
            f'It was {d} {m} {y} when we met.',
            f'Due date: {y}-{rnd.randint(1, 12):02d}-{d:02d}.',
            f'On {rnd.randint(1, 12)}/{d}/{y} the shop opened.',
            f'The {d}{"th" if 10 <= d <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(d % 10, "th")} of {m} is a holiday.',
        ]))
    for i in range(50):
        h = rnd.randint(0, 23)
        mi = rnd.choice([0, 5, 15, 30, 45, 59, 7])
        out.append(rnd.choice([
            f'The train leaves at {h}:{mi:02d}.',
            f'Wake me up at {h % 12 or 12}:{mi:02d} {rnd.choice(["am", "pm", "AM", "PM", "a.m.", "p.m."])}.',
            f'The store opens at {h % 12 or 12}{rnd.choice(["am", "pm", " o\'clock"])}.',
            f'It is {h:02d}:{mi:02d}:{rnd.randint(0, 59):02d} UTC now.',
            f'The call is from {h}:00 to {(h + 1) % 24}:30.',
        ]))
    return out


def templates():
    out = []
    for i in range(250):
        n1, n2 = rnd.choice(NAMES), rnd.choice(NAMES)
        out.append(rnd.choice([
            f'{n1} {rnd.choice(VERBED)} the {rnd.choice(ADJ)} {rnd.choice(NOUN)} in {rnd.choice(PLACES)}.',
            f'Did {n1} tell {n2} about the {rnd.choice(NOUN)}?',
            f"{n1}'s {rnd.choice(NOUN)} is more {rnd.choice(ADJ)} than {n2}'s.",
            f'{n1} and {n2} flew from {rnd.choice(PLACES)} to {rnd.choice(PLACES)} on {rnd.choice(DAYS)}.',
            f'The {rnd.choice(ADJ)} {rnd.choice(NOUN)}s were {rnd.choice(VERBED)} by {n1}.',
            f'{rnd.choice(ABBR)} {n1} {rnd.choice(VERBED)} {rnd.randint(2, 99)} {rnd.choice(NOUN)}s.',
            f'The {rnd.choice(ACRO)} and the {rnd.choice(ACRO)} {rnd.choice(VERBED)} the {rnd.choice(ACRO)} report.',
            f'Use {rnd.choice(CODE)} with {rnd.choice(CODE)} in {rnd.choice(CODE)}.',
            f'We measured {rnd.randint(1, 999)}{rnd.choice(UNITS)} and {rnd.randint(1, 99)}.{rnd.randint(0, 9)} {rnd.choice(UNITS)}.',
            f'{rnd.choice(ACRO)}s are {rnd.choice(ADJ)}, said {rnd.choice(ABBR)} {n2}.',
        ]))
    for w, ts in HOMO:
        for t in ts:
            out.append(t.format(w=w))
            out.append(t.format(w=w).upper())
            out.append(t.format(w=w.capitalize()) if t.startswith('{w}') else t.format(w=w).replace(w, w.capitalize(), 1))
    for c in CODE:
        out.append(f'Have you tried {c} yet?')
    for a in ACRO:
        out.append(f'The {a} is important. {a}s matter.')
    for a in ABBR:
        out.append(f'Look at {a} 5 in the notes.')
    contractions = ["I'm", "you're", "he's", "she's", "it's", "we're", "they're", "I've", "you've", "we've",
                    "they've", "I'd", "you'd", "he'd", "she'd", "we'd", "they'd", "I'll", "you'll", "he'll",
                    "she'll", "we'll", "they'll", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't",
                    "hadn't", "won't", "wouldn't", "don't", "doesn't", "didn't", "can't", "couldn't", "shouldn't",
                    "mightn't", "mustn't", "shan't", "needn't", "let's", "that's", "who's", "what's", "where's",
                    "here's", "there's", "how's", "y'all", "o'clock", "could've", "would've", "should've", "ain't",
                    "gonna", "wanna", "gotta", "lemme", "gimme", "dunno", "kinda", "sorta", "'em", "'cause", "c'mon"]
    for c in contractions:
        out.append(f'{c[0].upper() + c[1:]} the reason, {c} not?')
        out.append(f'Well, {c} fine.'.replace("'", '\u2019'))
    for i in range(60):
        a = rnd.choice(ADJ + NOUN)
        b = rnd.choice(ADJ + NOUN + VERBED)
        out.append(rnd.choice([f'A {a}-{b} approach.', f'The {a}--{b} issue.', f'Our {a} - {b} plan.',
                               f'The {a}/{b} option.', f'The {a}_{b} variable.', f'The {a}.{b} module.',
                               f'{a.upper()}-{b} ratio.', f'Mixed {a}{b.capitalize()} names.']))
    puncts = ['!', '?', '...', '…', '?!', '!!', ';', ':', ' -', ' —', '—', ',']
    for i in range(80):
        s = f'{rnd.choice(NAMES)} {rnd.choice(VERBED)} the {rnd.choice(NOUN)}'
        out.append(rnd.choice([
            s + rnd.choice(puncts) + ' ' + rnd.choice(['Then', 'and', '"Why"', '(maybe)', "'yes'", '[sic]']) + ' it ended.',
            '"' + s + '," he said.', '\u201c' + s + '!\u201d', '(' + s + ')', '[' + s + ']', '\u2018' + s + '\u2019',
            s + '.' * rnd.randint(2, 5), '--' + s + '--', '* ' + s, '>> ' + s, s + ' :-)', s + ' ;-)',
        ]))
    emojis = ['😀', '😂', '❤️', '👍', '🎉', '🔥', '✅', '🚀', '😉', '🙈', '👨‍👩‍👧', '🇩🇪', '🏳️‍🌈', '💯', '🤔', '☕']
    for i in range(40):
        out.append(f'{rnd.choice(NAMES)} loved the {rnd.choice(NOUN)} {rnd.choice(emojis)}{rnd.choice(["", "!", " lol"])}')
    md = ['**{x}**', '*{x}*', '_{x}_', '`{x}`', '~~{x}~~', '[{x}](https://example.com)', '# {x}', '- {x}', '> {x}',
          '1. {x}', '![{x}](img.png)', '<b>{x}</b>', '&nbsp;{x}', '{x}\\n', '__{x}__']
    for i in range(60):
        x = f'the {rnd.choice(ADJ)} {rnd.choice(NOUN)}'
        out.append(f'Here is {rnd.choice(md).format(x=x)} for you.')
    return out


def stdlib_sentences(limit):
    import pydoc  # noqa: F401
    import importlib
    mods = ['os', 'sys', 're', 'json', 'collections', 'itertools', 'functools', 'pathlib', 'subprocess',
            'threading', 'asyncio', 'logging', 'argparse', 'datetime', 'decimal', 'fractions', 'random',
            'statistics', 'string', 'textwrap', 'unicodedata', 'http.client', 'urllib.request', 'email.message',
            'csv', 'sqlite3', 'socket', 'ssl', 'hashlib', 'hmac', 'secrets', 'shutil', 'tempfile', 'glob',
            'zipfile', 'tarfile', 'gzip', 'pickle', 'copy', 'pprint', 'enum', 'dataclasses', 'typing', 'abc',
            'contextlib', 'inspect', 'traceback', 'unittest', 'doctest', 'timeit', 'heapq', 'bisect', 'array',
            'queue', 'sched', 'calendar', 'locale', 'gettext', 'codecs', 'io', 'struct', 'math', 'cmath',
            'operator', 'weakref', 'types', 'xml.etree.ElementTree', 'html.parser', 'configparser', 'base64',
            'binascii', 'difflib', 'filecmp', 'fnmatch', 'getpass', 'imaplib', 'smtplib', 'mimetypes', 'platform',
            'select', 'selectors', 'signal', 'mmap', 'ctypes', 'multiprocessing', 'concurrent.futures', 'uuid',
            'ipaddress', 'wave', 'turtle', 'tkinter', 'curses', 'zoneinfo', 'graphlib', 'tomllib']
    texts = []
    for name in mods:
        try:
            m = importlib.import_module(name)
        except Exception:  # noqa: BLE001
            continue
        objs = [m] + [getattr(m, a) for a in dir(m) if not a.startswith('_')]
        for o in objs:
            d = getattr(o, '__doc__', None)
            if isinstance(d, str):
                texts.append(d)
    sents = []
    seen = set()
    for d in texts:
        d = re.sub(r'\s+', ' ', d)
        for s in re.split(r'(?<=[.!?])\s+(?=[A-Z])', d):
            s = s.strip()
            if 25 <= len(s) <= 300 and s not in seen and re.search(r'[a-z]{3}', s) and '>>>' not in s:
                seen.add(s)
                sents.append(s)
    rnd.shuffle(sents)
    return sents[:limit]


def paragraphs(pool, n):
    out = []
    for i in range(n):
        k = rnd.randint(8, 30)
        out.append(' '.join(rnd.choice(pool) for _ in range(k)))
    for i in range(20):
        out.append('\n'.join(rnd.choice(pool) for _ in range(rnd.randint(2, 6))))
    # one very long sentence without punctuation breaks
    words = ' '.join(rnd.choice(ADJ + NOUN + NAMES) for _ in range(150))
    out.append('This sentence goes on and on with ' + words + ' and it never really stops')
    out.append(', '.join(rnd.choice(ADJ + NOUN) for _ in range(200)) + '.')
    out.append('; '.join(f'item {i}' for i in range(120)) + '.')
    out.append(' '.join(str(rnd.randint(0, 10 ** 6)) for _ in range(120)))
    return out


def main():
    hand = [l.replace('\\n', '\n') for l in HAND.strip().split('\n') if l.strip()]
    corpus = []
    corpus += hand
    corpus += numbers()
    corpus += money()
    corpus += dates_times()
    corpus += templates()
    nat = stdlib_sentences(1500)
    corpus += nat
    corpus += paragraphs(hand + nat, 120)
    seen = set()
    final = []
    for c in corpus:
        if c not in seen:
            seen.add(c)
            final.append(c)
    json.dump(final, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print(len(final), 'texts; handwritten', len(hand), 'natural', len(nat), file=sys.stderr)


if __name__ == '__main__':
    main()

# Theme music: sources and licences

Every theme of Diashow Studio has two or three bundled songs (the first is its default), and a small
music library adds songs by mood; songs marked "– (music library)" belong to no theme. All of them are
free to use, change and share without credit, including in exported videos that are published
(YouTube, WhatsApp, a school website): CC0 1.0 or public domain, for the recording and the
composition. The songs were chosen and checked on 2026-10-12. The licence statements below are
quoted from each song's own page. Songs longer than 2:30 are cut there with a fade (they loop in long
slideshows anyway).

The id is the song's file name (`<id>.m4a`) and is stored in projects, so it never changes.

`npm run theme-music -- <folder>` made the `.m4a` files from the originals listed here:
- it cut silence at the start or end (`start` and `maxSeconds` in the folder's `sources.json`);
- it levelled them to −16 LUFS;
- it encoded them as AAC 128 kbps.

SHA-256 refers to the downloaded original.

| Id | Themes | Moods | Song | Artist | Licence | Page | Original file (SHA-256) |
|---|---|---|---|---|---|---|---|
| `kenburns` | Ken Burns | calm, emotional | Falling stars | Ondrosik | CC0 1.0 | https://freemusicarchive.org/music/Ondrosik/enchanted-valley/falling-stars/ | MP3 320k, `8821b6ab7105d71a39f1789c9a596362bb2508c8ec694395bd1ba7fdbb70db74` |
| `kenburns-2` | Ken Burns | calm, emotional | In search of the rainbow's end | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/The_Rainbows_End/In_search_of_the_rainbows_end/ | MP3, `2bce00bda73f5cd9cefdbccc2436efd126e5ea08eac83ba7a1dd8c4b420b1ca8` |
| `kenburns-3` | Ken Burns | calm, emotional | Chopin: Cello Sonata Op. 65, III. Largo | Yeonjin Kim, Christopher Harding (Musopen) | Public domain (Musopen recording; composition public domain) | https://commons.wikimedia.org/wiki/File:Chopin_-_Cello_Sonata_in_G_minor,_Op._65_-_III._Largo_(Christopher_Harding,_Yeonjin_Kim).flac | FLAC, `9f04eca0ecb52b71626c33894f92e924a3345d35ffb1ab6787235d8d9b91962d` |
| `origami` | Origami | cheerful, upbeat | Yippee ! | Loyalty Freak Music | CC0 1.0 | https://freemusicarchive.org/music/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_08_Yippee_/ | MP3 320k, `6e227853ce8ef7094aa3847f62e8c032794ff45a46d5e3d510d69eccc8b6d564` |
| `origami-2` | Origami | cheerful, upbeat | bounce bounce | Ondrosik | CC0 1.0 | https://freemusicarchive.org/music/Ondrosik/enchanted-valley/bounce-bounce/ | MP3, `cecaf822f3f332977913cefe9a31eb177f288ba9fa54ff78018ab778e0c960b3` |
| `origami-3` | Origami | cheerful, upbeat | Happy Dance | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/power-pop/happy-dance-2/ | MP3, `75d7247e6025a9a0372a2069a0634301d94e92793a03f90a2f082acffcf3851a` |
| `reflections` | Reflections | calm, emotional | Above the Earth | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/This_train_doesnt_stop_at_Rugby/Above_the_Earth/ | MP3 320k, `d4e4fc7af3256bfb7a800903d441c3f6a3c47af8bb83be18bce755da84a98983` |
| `reflections-2` | Reflections | calm, nostalgic | Moon Unit | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/moon-unit-lofi-reflection-dreamy/ | MP3, `6b06327a16c4f6e0f039228288be0097c565845d45a8510b3697acac0e1a560f` |
| `reflections-3` | Reflections | calm, emotional | Whispered | Ondrosik | CC0 1.0 | https://freemusicarchive.org/music/Ondrosik/whispered/whispered/ | MP3, `be24689e9075387900045550de80625dd8e53046e0377a352857cf8a939f664e` |
| `panels` | Sliding Panels | upbeat, nostalgic | Back In The 80s | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/power-pop/back-in-the-80s/ | MP3 320k, `d9ace2cffbd5fab3a5e151e578062eb3925a0e670227a534e299fe7f660fdca5` |
| `panels-2` | Sliding Panels | upbeat, cheerful | Funky Pop | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/power-pop/funky-pop/ | MP3, `f4ece98b361ba68fdfa5c94c8856e639c64459f10b10c5294e523e3c00d9bbcf` |
| `panels-3` | Sliding Panels | upbeat, cheerful | Sunlit Groove | Ondrosik | CC0 1.0 | https://freemusicarchive.org/music/Ondrosik/burnout/sunlit-groove/ | MP3, `c47ea77f487f075a433800a8e5239aa06c0e4b44202c70f2d450ab0bc766ab90` |
| `vintage` | Vintage Prints | nostalgic, calm | Journey with Russ | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/Kevelin_and_Chestnuts_Adventures/Journey_with_Russ/ | MP3 320k, `44e07a9ac9333b4efa65cde1a6d1b26d95dc725a80904274e5515a529efee925` |
| `vintage-2` | Vintage Prints | nostalgic, cheerful | Botsford: Black and White Rag | James Brigham | Public domain (performance released by James Brigham; composition 1908) | https://commons.wikimedia.org/wiki/File:%22Black_and_White_Rag%22_(1908),_by_George_Botsford.flac | FLAC, `a8911cc95b750590f073a1f7968efe2ab2a938f58840b1e7c58bd1a048b635dd` |
| `vintage-3` | Vintage Prints | nostalgic, cheerful | Grandpa's great escape | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/singles-compilation-1/grandpas-great-escape/ | MP3, `3ea3672e3c8300ff6f9cb8ed5d19f17a27a4226b064af9562b7361c0fdcd8347` |
| `classic` | Classic | festive, cheerful | Joseph Haydn: String Quartet Op. 64 No. 5 "The Lark", III. Menuetto. Allegretto | Musopen String Quartet | Public domain (recording: Musopen, Public Domain Mark; composition: Haydn, died 1809) | https://commons.wikimedia.org/wiki/File:Haydn_-_String_Quartet,_Op._64_No._5_in_D_major_%27The_Lark%27_-_III._Menuet._Allegretto_(Musopen_String_Quartet).flac | FLAC, `8038ab3435dc2f0e20a8bf165c5377c43b13176530afe33a78fee384c8fd02bb` |
| `classic-2` | Classic | calm, cheerful | Chopin: Waltz Op. 64 No. 3 | Diana Hughes (Musopen) | Public domain (Musopen recording; composition public domain) | https://commons.wikimedia.org/wiki/File:Chopin_-_Waltz_No._8_in_A-flat_major,_Op._64_No._3_(Diana_Hughes).flac | FLAC, `6ed8ea2f52b595acaa9d802cdc20f406b91730be6b8316c307c9f8a6874512ee` |
| `classic-3` | Classic | calm, cheerful | Grieg: Holberg Suite, Gavotte | Marine Chamber Orchestra (U.S. Marine Band) | Public domain (U.S. government work; composition public domain) | https://commons.wikimedia.org/wiki/File:Grieg%27s_Suite_for_Strings,_Op._40,_%22From_Holberg%E2%80%99s_Time%22_-_III._Gavotte-Musette-Gavotte_-_Chamber_Orchestra_-_United_States_Marine_Band.mp3 | MP3, `9fba395b654774c170866c56e6fac2310a904f3115e65cdbebe001c57e6331bf` |
| `magazine` | Magazine | upbeat | Classic | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/rock-montage/classic/ | MP3 320k, `eb9f2e7f92278f1ee39990b4a4ecf948c9b5cee0892c57d0fac29e614717d739` |
| `magazine-2` | Magazine | upbeat | Greater Manchester | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/Bills_Adventures/Greater_Manchester/ | MP3, `885b6456409f5aa223c626bb9b2a61d950b5f50705eeba7fe1512ec184ac3dc6` |
| `magazine-3` | Magazine | upbeat | High Sky | Patrick Davies | CC0 1.0 | https://freemusicarchive.org/music/patrick-davies/single/high-sky/ | MP3, `8adfbc0caf54507f95397c2894239a6370c90b73d9238d82b53cb901c024f9d9` |
| `retro` | Retro Film | nostalgic, upbeat | Roger Moore | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/singles-compilation-1/roger-moore/ | MP3 280k, `a679b4a375606bc3f924465409b6a5d55873a620310224d0bb5bc6e3d852d82a` |
| `retro-2` | Retro Film | upbeat, nostalgic | Uno Mas | The Airmen of Note (U.S. Air Force Band) | Public domain (U.S. government work; composition public domain) | https://commons.wikimedia.org/wiki/File:Uno_Mas_-_Airmen_of_Note_-_United_States_Air_Force_Band.mp3 | MP3, `520a61b2ef53dcbc6f5281d569a3b6eb1c432b49f75c9290c1bb1d8ffd1a027d` |
| `retro-3` | Retro Film | calm, nostalgic | Sax and Piano | Maarten Schellekens | CC0 1.0 | https://freemusicarchive.org/music/maarten-schellekens/public-domain-1/sax-and-piano-free-track/ | MP3, `83b8c88b10bbb21788636bccca8f0aa6817d195ef91557507d0981f323865ff1` |
| `scrapbook` | Scrapbook | cheerful, calm | Red Hair, Blue Sky | Monplaisir | CC0 1.0 | https://freemusicarchive.org/music/Monplaisir/Relaxing_Ukulele/Monplaisir_-_Relaxing_Ukulele_-_01_Red_Hair_Blue_Sky/ | MP3 320k, `9d1b8fe7b690a52206193218f6dedefd6ec5311dd8cde419f7c145c7a6a87202` |
| `scrapbook-2` | Scrapbook | cheerful, calm | Enchanted valley whistle | Ondrosik | CC0 1.0 | https://freemusicarchive.org/music/Ondrosik/enchanted-valley/enchanted-walley-whistle-extended-version/ | MP3, `dce237cf7c46f8ca02cf8e71731b35e861591825b56be7af96e542e0a01b5634` |
| `scrapbook-3` | Scrapbook | calm, cheerful | Ocean Breeze | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/ocean-breeze-lofi-ukulele-peaceful-mp3/ | MP3, `3dbc9713e17d3e23d942d36510ba046210f69d4e2df4ebb07e7d2ce4c2e6b358` |
| `snapshots` | Snapshots | cheerful | Go to the Picnic | Loyalty Freak Music | CC0 1.0 | https://freemusicarchive.org/music/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_01_Go_to_the_Picnic/ | MP3 320k, `dbeaad7bb137f39f5d3e7ee5c83b2ac53f4963cc92f3d3fe6321c490e1760cf1` |
| `snapshots-2` | Snapshots | cheerful, upbeat | Ice Cream with you | Loyalty Freak Music | CC0 1.0 | https://freemusicarchive.org/music/Loyalty_Freak_Music/POSITIVE_ATTITUDE_/Loyalty_Freak_Music_-_POSITIVE_ATTITUDE__-_05_Ice_Cream_with_you/ | MP3, `3c4f6ee9c73ce0a3d2bbb545e0f5b050f5e6c1561b6518f758388e09ffaa59d9` |
| `snapshots-3` | Snapshots | cheerful, nostalgic | Appalachian Mountains | TRG Banks | CC0 1.0 | https://freemusicarchive.org/music/TRG_Banks/Bills_Adventures/Appalachian_Mountains/ | MP3, `e391187a7e6cfc276b2f3f2d10ae474090ae5e6b3bd289c6248b63f9d2c31a71` |
| `shatter` | Shatter | upbeat, emotional | Drama | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/power-pop/drama/ | MP3 320k, `bacdf4eae1d6031a357837389b86f5b114997629be60ca9cb3d2e14284fee34b` |
| `shatter-2` | Shatter | upbeat, emotional | Dramatic Ending | Soft and Furious | CC0 1.0 | https://freemusicarchive.org/music/Soft_and_Furious/The_Merfolk_I_Should_Turn_To_Be/Soft_and_Furious_-_The_Merfolk_I_Should_Turn_To_Be_-_10_Dramatic_Ending/ | MP3, `fbe393a56339ce1274a72c43a9c58cf3bb2d4dfc5535098514ac5d48ca368ddf` |
| `shatter-3` | Shatter | upbeat | Fires Uptown | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/waves-of-nostalgia-2/fires-uptown/ | MP3, `01fc5e02157285c9ceb8f3c2d303768dfb02a43896f9c75a07629628330af126` |
| `festive-1` | – (music library) | festive, cheerful | Handel: Water Music, Alla hornpipe | Marine Chamber Orchestra (U.S. Marine Band) | Public domain (U.S. government work; composition public domain) | https://commons.wikimedia.org/wiki/File:Handel%27s_Water_Music_-_12._Alla_hornpipe_-_Chamber_Orchestra_-_United_States_Marine_Band.opus | Opus, `cbd5956d81eafb2a713dee5729ebc62d625c6417622335d6f4db82bc1662a1fe` |
| `festive-2` | – (music library) | festive, upbeat | Sousa: The Liberty Bell | U.S. Marine Band | Public domain (U.S. government work; composition public domain) | https://commons.wikimedia.org/wiki/File:Sousa%27s_%22The_Liberty_Bell%22_-_United_States_Marine_Band_(2017).mp3 | MP3, `df5036a059cb63d6bb9bdd8fccefc225a64f1a1ffd34d6d66b07a91ccd4dba17` |
| `christmas-1` | – (music library) | christmas, upbeat | God Rest Ye Merry Gentlemen (Synth Wave) | HoliznaCC0 | CC0 1.0 | https://freemusicarchive.org/music/holiznacc0/a-synth-wave-christmas-special/god-rest-ye-merry-gentlemen-synth-wave/ | MP3, `a9a015e8aec6fe47b903523d2045fa9ff728ab29adf97a4d66408b8e276fb784` |
| `christmas-2` | – (music library) | christmas, festive, upbeat | Good King Wenceslas and His Merry Band | The Airmen of Note (U.S. Air Force Band) | Public domain (U.S. government work; composition public domain) | https://commons.wikimedia.org/wiki/File:Good_King_Wenceslas_and_His_Merry_Band_-_Airmen_of_Note_-_United_States_Air_Force_Band.mp3 | MP3, `9ba51ebf4d3e547f0656834a138df2c74dc176827835183d82ee16e4509ff9bb` |
| `calm-1` | – (music library) | calm, emotional | Chopin: Nocturne in C-sharp minor | Frank Levy (Musopen) | Public domain (Musopen recording; composition public domain) | https://commons.wikimedia.org/wiki/File:Chopin_-_Nocturne_No._20_in_C-sharp_minor,_B._49_(Frank_Levy).flac | FLAC, `105eacce66ed298a2d6b1729910e5ecb29b9447ad7b6bb460a580006eca6e48f` |

## Licence statements

- **Free Music Archive songs.** Each song page says "‹Title› by ‹Artist› is licensed under a CC0 1.0 Universal License" and links to https://creativecommons.org/publicdomain/zero/1.0/. The artists also say so in their own words:
  - **TRG Banks:** "All tracks are in the Public Domain (CC0 1.0 Universal) … Any information claiming otherwise is false." Bandcamp offers no CC0 option, so his Bandcamp footer "all rights reserved" doesn't apply.
  - **HoliznaCC0:** "giving out truly unique and creative music for free as public domain". Only the CC0 uploads on Free Music Archive are meant here; his Bandcamp sells other songs under other terms.
  - **Loyalty Freak Music / Monplaisir** (one musician): "Do whatever you want with this, it's CC0."
  - **Ondrosik:** his 2026 albums (*Enchanted Valley*, *Whispered*, *Burnout*) are CC0. His older albums are under other licences.
  - **Maarten Schellekens:** "Sax and Piano" is on his separate album *PUBLIC DOMAIN* (CC0): "You can use this song totally for free, without the need to credit me!". Most of his other music is under other licences.
  - **Patrick Davies:** "High Sky" is CC0 on its page; no other licence was found for it.
- **Musopen recordings** (String Quartet, Diana Hughes, Frank Levy, Yeonjin Kim and Christopher Harding).
  - **The String Quartet** was recorded in 2012 for Musopen's Kickstarter project to release recordings into the public domain, and Musopen marks it with the Public Domain Mark.
  - **The Chopin recordings** come from Musopen's "Set Chopin Free" project. Wikimedia Commons says "This work has been released into the public domain by its author, Musopen. This applies worldwide." (`{{PD-author|Musopen}}`), and the compositions are public domain (Chopin died 1849, Haydn 1809).
- **U.S. Marine Band and U.S. Air Force Band** (Grieg, Handel, Sousa, "Uno Mas", "Good King Wenceslas"). Wikimedia Commons: "This file is a work of a United States Marine or employee, taken or made as part of that person's official duties. As a work of the U.S. federal government, it is in the public domain", and the same for the Air Force.
  - The compositions are public domain: Grieg died 1907, Handel 1759, Sousa 1932. "Uno Mas" was written by the band's saxophonist Roger Hogan, and the "Good King Wenceslas" arrangement by band member SMSgt Mike Crotty.
  - Works of the U.S. government are public domain in the United States; other countries may treat them differently.
- **James Brigham, "Black and White Rag"** (George Botsford, 1908, died 1949): Wikimedia Commons says the performance "has been released into the public domain by its author, James Brigham. This applies worldwide." It is a playback of his CC0 score, not a live pianist.

## YouTube Content ID

Third parties sometimes register popular CC0 songs in YouTube's Content ID, which is not allowed. Loyalty Freak Music / Monplaisir has documented such cases (https://rrrrroseazerty.neocities.org). If an exported video gets a claim for one of these songs:
1. Dispute it.
2. Explain that the song is CC0 or public domain.
3. Link the page in the table above.

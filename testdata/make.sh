#!/bin/sh
# Makes the spoken test clips with the Mac's built-in voice: testdata/make.sh
# The clips are 16 kHz, 16-bit, mono WAV files, which every part of the project can read.
# They are not kept in the repository; other systems can use any recording in that format.
set -eu
cd "$(dirname "$0")"

clip() {
    say -o "$1.aiff" "$2"
    afconvert -f WAVE -d LEI16@16000 -c 1 "$1.aiff" "$1.wav"
    rm "$1.aiff"
    echo "wrote testdata/$1.wav"
}

clip a "Hey Marcus, thanks for sending over the quarterly report. I had a look this morning and the numbers look solid. Can we meet on Thursday to go over the budget?"
clip b "Um, so I was thinking we could, uh, meet at five. Actually, no, let's make it 6 pm. At the, at the coffee shop on Main Street. You know, the one next to the library."
clip c "Okay, so for the release we need three things. First, update the change log. Second, um, bump the version number. And third, tag the release on GitHub."
clip long "This is a longer dictation meant to check how the engine behaves when I keep talking for more than a minute. I'm going to describe the plan for next week in some detail. On Monday, we start with the planning meeting at 9 30, and I would like everyone to bring their open issues so that we can sort them by priority. On Tuesday, the design team presents the new onboarding flow, which has three screens instead of five, and we need to decide whether the permission prompts come before or after the tutorial. Wednesday is reserved for focused work, so please do not schedule any meetings. On Thursday, we run the performance tests on the new build. The target is to transcribe ten seconds of speech in under half a second on a laptop, and to keep memory use below three gigabytes. Finally, on Friday, we write the release notes, record a short demo video, and publish the build to the beta channel. If anything slips, tell me as early as possible so that we can adjust the schedule instead of working through the weekend."

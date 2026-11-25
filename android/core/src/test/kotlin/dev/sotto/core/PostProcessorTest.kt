package dev.sotto.core

import org.junit.Assert.assertEquals
import org.junit.Test

class PostProcessorTest {
    private fun run(
        s: String,
        cleanup: CleanupLevel = CleanupLevel.LIGHT,
        tone: Tone = Tone.FORMAL,
        replacements: List<Replacement> = emptyList(),
        snippets: List<Snippet> = emptyList(),
    ) = PostProcessor.process(s, PostProcessor.Options(cleanup, tone, replacements, snippets))

    @Test fun fillersAreRemovedAndSentenceRecapitalized() {
        assertEquals("So I was thinking we could, meet at 5.", run("Um, so I was thinking we could, uh, meet at 5."))
        assertEquals("Second, bump the version.", run("Second, uhm, bump the version."))
        assertEquals("It is done. Next we ship.", run("It is done. Uh, next we ship."))
    }

    @Test fun wordsContainingFillerLettersSurvive() {
        assertEquals("The umbrella and the hummus are in the drum.", run("The umbrella and the hummus are in the drum."))
        assertEquals("Uhura hummed.", run("Uhura hummed."))
    }

    @Test fun stuttersCollapseButDeliberateDoublesStay() {
        assertEquals("I think the cache is stale", run("I I think the the cache is stale"))
        assertEquals("He said that that was fine, bye bye", run("He said that that was fine, bye bye"))
    }

    @Test fun verbatimLeavesEverything() {
        assertEquals("Um, the the thing.", run("Um, the the thing.", cleanup = CleanupLevel.VERBATIM))
    }

    @Test fun numbersAreNotTreatedAsStutters() {
        assertEquals("Call 5 5 5 0 1 2 3", run("Call 5 5 5 0 1 2 3"))
        assertEquals("Version 3.5 is out. e.g. this", run("Version 3.5 is out. e.g. this"))
    }

    @Test fun replacementsMatchWholeWordsIgnoringCase() {
        val r = listOf(Replacement("soto", "Sotto"), Replacement("git hub", "GitHub"))
        assertEquals("Push Sotto to GitHub, not sotoro.", run("Push soto to Git  Hub, not sotoro.", replacements = r))
    }

    @Test fun replacementTemplateCharactersAreLiteral() {
        val r = listOf(Replacement("price", "\$5 \\ each"))
        assertEquals("The \$5 \\ each", run("The price", replacements = r))
    }

    @Test fun snippetSaidAloneReplacesTheWholeUtterance() {
        val s = listOf(Snippet("my address", "1 Infinite Loop\nCupertino, CA"))
        assertEquals("1 Infinite Loop\nCupertino, CA", run("My address.", snippets = s))
    }

    @Test fun snippetInsideSentenceAndToneNotApplied() {
        val s = listOf(Snippet("calendar link", "https://cal.example/me"))
        assertEquals("Book a slot at https://cal.example/me.", run("Book a slot at calendar link.", tone = Tone.VERY_CASUAL, snippets = s))
    }

    @Test fun tone() {
        val s = "Hey, are you free tomorrow? I'm around. API access works. Let's do 12."
        assertEquals(s, run(s, tone = Tone.FORMAL))
        assertEquals("Hey, are you free tomorrow? I'm around. API access works. Let's do 12", run(s, tone = Tone.CASUAL))
        assertEquals("hey, are you free tomorrow? I'm around. API access works. let's do 12", run(s, tone = Tone.VERY_CASUAL))
    }

    @Test fun toneLeavesListsAndEllipsesAlone() {
        assertEquals("Three things:\n1. Ship.\n2. Rest.", run("Three things:\n1. Ship.\n2. Rest.", tone = Tone.VERY_CASUAL))
        assertEquals("Well...", run("Well...", tone = Tone.CASUAL))
    }

    @Test fun fitAddsSpaceAndContinuesSentence() {
        assertEquals(" and then we left.", PostProcessor.fit("And then we left.", "We ate"))
        assertEquals(" Next sentence.", PostProcessor.fit("Next sentence.", "Done."))
        assertEquals("Next sentence.", PostProcessor.fit("Next sentence.", "Done. "))
        assertEquals("Hello.", PostProcessor.fit("Hello.", ""))
        assertEquals("Hello.", PostProcessor.fit("Hello.", null))
        assertEquals("Hello", PostProcessor.fit("Hello", "say ("))
    }

    @Test fun fitKeepsCapitalsThatMatter() {
        assertEquals(" I think so.", PostProcessor.fit("I think so.", "well,"))
        assertEquals(" API keys rotate.", PostProcessor.fit("API keys rotate.", "the"))
        assertEquals(" Sotto works.", PostProcessor.fit("Sotto works.", "and", listOf("Sotto")))
        assertEquals("New line", PostProcessor.fit("New line", "first line\n"))
    }

    @Test fun emptyAndFillerOnlyInput() {
        assertEquals("", run("   "))
        assertEquals("", run("Um, uh."))
    }
}

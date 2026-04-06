package com.glyph.tv

import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import coil.compose.AsyncImage
import com.squareup.moshi.Json
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import retrofit2.http.*

// ══════════════════════════════════════════
//  GLYPH DESIGN TOKENS
// ══════════════════════════════════════════

private object Glyph {
    val bgPrimary = Color(0xFF101018)
    val bgSecondary = Color(0xFF181820)
    val bgCard = Color(0xFF16161f)
    val bgCardHover = Color(0xFF1e1e2e)
    val bgTertiary = Color(0xFF1e1e2a)
    val textPrimary = Color(0xFFEEEEF2)
    val textSecondary = Color(0xFF8888A0)
    val textMuted = Color(0xFF555570)
    val accentPrimary = Color(0xFFa855f7)
    val accentSecondary = Color(0xFF6366f1)
    val borderSubtle = Color(0x0FFFFFFF)
    val borderAccent = Color(0x4Da855f7)
    val danger = Color(0xFFef4444)
    val radiusLg = 14.dp
    val radiusMd = 10.dp
    val radiusSm = 6.dp
    val accentGradient = Brush.linearGradient(listOf(accentPrimary, accentSecondary))
}

// ══════════════════════════════════════════
//  GLYPH THEME
// ══════════════════════════════════════════

@Composable
private fun GlyphTheme(content: @Composable () -> Unit) {
    val colors = darkColorScheme(
        primary = Glyph.accentPrimary,
        secondary = Glyph.accentSecondary,
        background = Glyph.bgPrimary,
        surface = Glyph.bgSecondary,
        surfaceVariant = Glyph.bgCard,
        onPrimary = Color.White,
        onSecondary = Color.White,
        onBackground = Glyph.textPrimary,
        onSurface = Glyph.textPrimary,
        onSurfaceVariant = Glyph.textSecondary,
        error = Glyph.danger,
    )
    MaterialTheme(colorScheme = colors, content = content)
}

// ══════════════════════════════════════════
//  DATA MODELS (matching existing server API)
// ══════════════════════════════════════════

data class Library(
    val id: String = "",
    val name: String = "",
    val path: String = "",
    val type: String = "videos",
    val videoCount: Int = 0,
    val folderCount: Int = 0,
    val showRecentAdded: Boolean = true,
    val trackContinueWatching: Boolean = true
)

data class Video(
    val id: String = "",
    val title: String = "",
    val fileName: String = "",
    val extension: String = "",
    val size: Long = 0,
    val modifiedAt: Double = 0.0,
    val hasFunscript: Boolean = false,
    val durationSec: Double = 0.0,
    val filePath: String = "",
    val libraryId: String = "",
    val libraryType: String = "",
    val hasThumbnail: Boolean = false,
    val thumbVersion: Double = 0.0,
    val tags: List<String> = emptyList(),
    val performers: List<PerformerRef> = emptyList()
)

data class WatchProgressItem(
    val id: String = "",
    val title: String = "",
    val filePath: String = "",
    val size: Long = 0,
    val modifiedAt: Double = 0.0,
    val thumbVersion: Double = 0.0,
    val libraryId: String = "",
    val libraryType: String = "",
    val tags: List<String> = emptyList(),
    val performers: List<PerformerRef> = emptyList(),
    val hasThumbnail: Boolean = false,
    val hasFunscript: Boolean = false,
    val lastPositionSec: Double = 0.0,
    val durationSec: Double = 0.0,
    val updatedAt: Double = 0.0
)

data class PerformerRef(
    val id: String = "",
    val name: String = "",
    val gender: String = ""
)

data class WatchProgressUpdate(
    val videoId: String,
    val positionSec: Double,
    val durationSec: Double
)

data class SeriesFolder(
    val id: String = "",
    val name: String = "",
    val path: String = "",
    val videoCount: Int = 0,
    val funscriptCount: Int = 0,
    val hasPoster: Boolean = false,
    val posterVersion: Double = 0.0,
    val modifiedAt: Double = 0.0,
    val tags: List<String> = emptyList()
)

data class SeriesDetailVideo(
    val id: String = "",
    val title: String = "",
    val fileName: String = "",
    val durationSec: Double = 0.0,
    val hasThumbnail: Boolean = false,
    val thumbVersion: Double = 0.0,
    val hasFunscript: Boolean = false
)

data class SeriesSeason(
    val name: String = "",
    val path: String = "",
    val videos: List<SeriesDetailVideo> = emptyList()
)

data class SeriesMetadata(
    val title: String? = null,
    val overview: String? = null,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    val numberOfSeasons: Int? = null,
    val numberOfEpisodes: Int? = null,
    val backdropIsLocal: Boolean = false,
    val backdropUpdatedAt: Long? = null
)

data class SeriesDetailResponse(
    val name: String = "",
    val path: String = "",
    val metadata: SeriesMetadata? = null,
    val hasPoster: Boolean = false,
    val posterVersion: Double = 0.0,
    val seasons: List<SeriesSeason> = emptyList(),
    val directVideos: List<SeriesDetailVideo> = emptyList()
)

// ══════════════════════════════════════════
//  API INTERFACE (existing server endpoints)
// ══════════════════════════════════════════

interface GlyphApi {
    @GET("/api/libraries")
    suspend fun libraries(): List<Library>

    @GET("/api/libraries/{id}/videos")
    suspend fun libraryVideos(
        @Path("id") id: String,
        @Query("sort") sort: String? = null,
        @Query("order") order: String? = null,
        @Query("search") search: String? = null,
        @Query("limit") limit: Int? = null
    ): List<Video>

    @GET("/api/libraries/{id}/folders")
    suspend fun libraryFolders(@Path("id") id: String): List<SeriesFolder>

    @GET("/api/series/detail")
    suspend fun seriesDetail(@Query("path") path: String): SeriesDetailResponse

    @GET("/api/watch-progress")
    suspend fun watchProgress(@Query("limit") limit: Int = 20): List<WatchProgressItem>

    @POST("/api/watch-progress")
    suspend fun updateWatchProgress(@Body body: WatchProgressUpdate): Any

    @GET("/api/videos/{id}/audio-tracks")
    suspend fun audioTracks(@Path("id") id: String): List<Any>
}

// ══════════════════════════════════════════
//  API BUILDER
// ══════════════════════════════════════════

private fun buildApi(baseUrl: String): GlyphApi {
    val normalized = baseUrl.trim().replace("\n", "").replace("\r", "")
    val fallback = "http://10.0.2.2:4000/"
    val cleanBase = when {
        normalized.isBlank() -> fallback
        normalized.endsWith("/") -> normalized
        else -> "$normalized/"
    }
    val okHttp = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    val moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
    return Retrofit.Builder()
        .baseUrl(cleanBase)
        .client(okHttp)
        .addConverterFactory(MoshiConverterFactory.create(moshi).asLenient())
        .build()
        .create(GlyphApi::class.java)
}

// ══════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════

private fun thumbUrl(baseUrl: String, videoId: String): String {
    return "${baseUrl.trimEnd('/')}/api/videos/${Uri.encode(videoId)}/thumbnail"
}

private fun streamUrl(baseUrl: String, videoId: String, startTime: Double = 0.0): String {
    val base = "${baseUrl.trimEnd('/')}/api/videos/${Uri.encode(videoId)}/stream"
    return if (startTime > 0) "$base?startTime=$startTime" else base
}

private fun directPlayUrl(baseUrl: String, videoId: String): String {
    return "${baseUrl.trimEnd('/')}/api/videos/${Uri.encode(videoId)}/play"
}

private fun posterUrl(baseUrl: String, folderPath: String): String {
    return "${baseUrl.trimEnd('/')}/api/poster?path=${Uri.encode(folderPath)}"
}

private fun firstBucketChar(text: String): Char {
    val ch = text.trim().firstOrNull()?.uppercaseChar() ?: '#'
    return if (ch in 'A'..'Z') ch else '#'
}

private fun formatDuration(sec: Double): String {
    val total = sec.toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    return if (h > 0) "${h}h ${m}min" else "${m}min"
}

// ══════════════════════════════════════════
//  MAIN ACTIVITY
// ══════════════════════════════════════════

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { GlyphTheme { GlyphTvApp() } }
    }
}

// ══════════════════════════════════════════
//  APP NAVIGATION
// ══════════════════════════════════════════

@Composable
private fun GlyphTvApp() {
    val nav = rememberNavController()
    var baseUrl by rememberSaveable { mutableStateOf("http://10.0.2.2:4000") }
    var connected by rememberSaveable { mutableStateOf(false) }
    val api = remember(baseUrl) {
        runCatching { buildApi(baseUrl) }.getOrElse { buildApi("http://10.0.2.2:4000") }
    }

    val startRoute = if (connected) "home" else "connect"
    NavHost(navController = nav, startDestination = startRoute) {
        composable("connect") {
            ConnectScreen(
                baseUrl = baseUrl,
                onBaseUrlChange = { baseUrl = it },
                api = api,
                onConnected = {
                    connected = true
                    nav.navigate("home") { popUpTo("connect") { inclusive = true } }
                }
            )
        }
        composable("home") {
            HomeScreen(
                api = api, baseUrl = baseUrl,
                onOpenLibrary = { nav.navigate("library/$it") },
                onOpenVideo = { nav.navigate("player/$it") },
                onOpenSearch = { nav.navigate("search") },
                onOpenLibraries = { nav.navigate("libraries") }
            )
        }
        composable("libraries") {
            LibrariesScreen(api = api, onOpenLibrary = { nav.navigate("library/$it") }, onBack = { nav.popBackStack() })
        }
        composable("search") {
            SearchScreen(api = api, baseUrl = baseUrl, onPlay = { nav.navigate("player/$it") }, onBack = { nav.popBackStack() })
        }
        composable(
            route = "library/{libraryId}",
            arguments = listOf(navArgument("libraryId") { type = NavType.StringType })
        ) { entry ->
            val libraryId = entry.arguments?.getString("libraryId").orEmpty()
            LibraryContentScreen(
                api = api, baseUrl = baseUrl, libraryId = libraryId,
                onOpenSeriesFolder = { nav.navigate("seriesDetail/${Uri.encode(it)}") },
                onPlay = { nav.navigate("player/$it") },
                onBack = { nav.popBackStack() }
            )
        }
        composable(
            route = "seriesDetail/{folderPath}",
            arguments = listOf(navArgument("folderPath") { type = NavType.StringType })
        ) { entry ->
            val folderPath = Uri.decode(entry.arguments?.getString("folderPath").orEmpty())
            SeriesDetailScreen(
                api = api, baseUrl = baseUrl, folderPath = folderPath,
                onPlay = { nav.navigate("player/$it") },
                onBack = { nav.popBackStack() }
            )
        }
        composable(
            route = "player/{videoId}",
            arguments = listOf(navArgument("videoId") { type = NavType.StringType })
        ) { entry ->
            val videoId = entry.arguments?.getString("videoId").orEmpty()
            PlayerScreen(api = api, baseUrl = baseUrl, videoId = videoId, onBack = { nav.popBackStack() })
        }
    }
}

// ══════════════════════════════════════════
//  REUSABLE COMPONENTS
// ══════════════════════════════════════════

@Composable
private fun GlyphButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    accent: Boolean = false
) {
    val textColor = if (accent) Color.White else Glyph.textPrimary
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(Glyph.radiusSm))
            .then(
                if (accent) Modifier.background(Glyph.accentGradient)
                else Modifier.background(Glyph.bgCard).border(1.dp, Glyph.borderSubtle, RoundedCornerShape(Glyph.radiusSm))
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(text, color = if (enabled) textColor else Glyph.textMuted, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun GlyphSearchField(
    value: String, onValueChange: (String) -> Unit, onSearch: () -> Unit,
    modifier: Modifier = Modifier, placeholder: String = "Suchen..."
) {
    OutlinedTextField(
        value = value, onValueChange = onValueChange, modifier = modifier, singleLine = true,
        placeholder = { Text(placeholder, color = Glyph.textMuted) },
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Glyph.textPrimary, unfocusedTextColor = Glyph.textPrimary,
            focusedBorderColor = Glyph.accentPrimary, unfocusedBorderColor = Glyph.borderSubtle,
            focusedContainerColor = Glyph.bgTertiary, unfocusedContainerColor = Glyph.bgTertiary,
            cursorColor = Glyph.accentPrimary,
        ),
        shape = RoundedCornerShape(Glyph.radiusLg),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() })
    )
}

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Glyph.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
        letterSpacing = (-0.3).sp, modifier = modifier.padding(bottom = 8.dp))
}

@Composable
private fun SubSectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Glyph.textPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold,
        modifier = modifier.padding(bottom = 6.dp))
}

@Composable
private fun GlyphTopBar(title: String, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Glyph.bgSecondary).padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (onBack != null) GlyphButton(text = "←", onClick = onBack)
        Text(title, color = Glyph.textPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        actions()
    }
}

// ── Thumbnail ──

@Composable
private fun VideoThumbnail(baseUrl: String, videoId: String?, hasThumbnail: Boolean, modifier: Modifier = Modifier, aspectRatio: Float = 16f / 9f) {
    val shape = RoundedCornerShape(Glyph.radiusMd)
    if (videoId == null) {
        Box(
            modifier = modifier.aspectRatio(aspectRatio).clip(shape).background(Glyph.bgTertiary),
            contentAlignment = Alignment.Center
        ) { Text("🎬", fontSize = 28.sp) }
        return
    }
    var loadFailed by remember(baseUrl, videoId, hasThumbnail) { mutableStateOf(false) }
    Box(modifier = modifier.aspectRatio(aspectRatio).clip(shape).background(Glyph.bgTertiary)) {
        if (!loadFailed) {
            AsyncImage(
                model = thumbUrl(baseUrl, videoId),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                onError = { loadFailed = true }
            )
        }
        if (loadFailed) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("🎬", fontSize = 28.sp)
            }
        }
    }
}

// ── Video grid card ──

@Composable
private fun VideoGridCard(baseUrl: String, video: Video, onClick: () -> Unit, modifier: Modifier = Modifier) {
    var focused by remember { mutableStateOf(false) }
    val borderColor by animateColorAsState(if (focused) Glyph.borderAccent else Glyph.borderSubtle, tween(150), label = "")
    val bgColor by animateColorAsState(if (focused) Glyph.bgCardHover else Glyph.bgCard, tween(150), label = "")

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(Glyph.radiusLg)).background(bgColor)
            .border(1.dp, borderColor, RoundedCornerShape(Glyph.radiusLg))
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick)
    ) {
        VideoThumbnail(baseUrl = baseUrl, videoId = video.id, hasThumbnail = video.hasThumbnail, modifier = Modifier.fillMaxWidth())
        Column(modifier = Modifier.padding(10.dp, 8.dp)) {
            Text(video.title, color = Glyph.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (video.durationSec > 0) {
                Text(formatDuration(video.durationSec), color = Glyph.textMuted, fontSize = 11.sp)
            }
        }
    }
}

// ── Continue watching card ──

@Composable
private fun ContinueWatchingCard(baseUrl: String, video: WatchProgressItem, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val borderColor by animateColorAsState(if (focused) Glyph.borderAccent else Glyph.borderSubtle, tween(150), label = "")
    val progress = if (video.durationSec > 0) (video.lastPositionSec / video.durationSec).toFloat().coerceIn(0f, 1f) else 0f

    Column(
        modifier = Modifier.width(280.dp).clip(RoundedCornerShape(Glyph.radiusLg)).background(Glyph.bgCard)
            .border(1.dp, borderColor, RoundedCornerShape(Glyph.radiusLg))
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick)
    ) {
        VideoThumbnail(baseUrl = baseUrl, videoId = video.id, hasThumbnail = video.hasThumbnail, modifier = Modifier.fillMaxWidth())
        Box(modifier = Modifier.fillMaxWidth().height(3.dp).background(Glyph.bgTertiary)) {
            Box(modifier = Modifier.fillMaxHeight().fillMaxWidth(progress).background(Glyph.accentGradient))
        }
        Column(modifier = Modifier.padding(10.dp, 8.dp)) {
            Text(video.title, color = Glyph.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${formatDuration(video.lastPositionSec)} / ${formatDuration(video.durationSec)}", color = Glyph.textMuted, fontSize = 11.sp)
        }
    }
}

// ── Library card ──

@Composable
private fun LibraryCard(library: Library, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val borderColor by animateColorAsState(if (focused) Glyph.borderAccent else Glyph.borderSubtle, tween(150), label = "")
    val typeIcon = when (library.type) { "series" -> "📺"; "vr" -> "🥽"; else -> "🎬" }
    val typeLabel = when (library.type) { "series" -> "Serien"; "vr" -> "VR"; else -> "Videos" }

    Box(
        modifier = Modifier.fillMaxWidth().height(140.dp).clip(RoundedCornerShape(Glyph.radiusLg)).background(Glyph.bgCard)
            .border(1.dp, borderColor, RoundedCornerShape(Glyph.radiusLg))
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick).padding(18.dp),
        contentAlignment = Alignment.BottomStart
    ) {
        Text(typeIcon, fontSize = 32.sp, modifier = Modifier.align(Alignment.TopEnd))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(library.name, color = Glyph.textPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("${library.videoCount} $typeLabel", color = Glyph.textSecondary, fontSize = 13.sp)
        }
    }
}

// ── Series folder card ──

@Composable
private fun SeriesFolderCard(baseUrl: String, folder: SeriesFolder, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val borderColor by animateColorAsState(if (focused) Glyph.borderAccent else Glyph.borderSubtle, tween(150), label = "")

    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Glyph.radiusLg)).background(Glyph.bgCard)
            .border(1.dp, borderColor, RoundedCornerShape(Glyph.radiusLg))
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick)
    ) {
        val posterShape = RoundedCornerShape(topStart = Glyph.radiusLg, topEnd = Glyph.radiusLg)
        var posterLoadFailed by remember(baseUrl, folder.path, folder.posterVersion) { mutableStateOf(false) }
        Box(
            modifier = Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(posterShape).background(Glyph.bgTertiary),
            contentAlignment = Alignment.Center
        ) {
            if (!posterLoadFailed) {
                AsyncImage(
                    model = posterUrl(baseUrl, folder.path),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                    onError = { posterLoadFailed = true }
                )
            }
            if (posterLoadFailed) {
                Text("📁", fontSize = 36.sp)
            }
        }
        Column(modifier = Modifier.padding(10.dp, 8.dp)) {
            Text(folder.name, color = Glyph.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("${folder.videoCount} Videos", color = Glyph.textMuted, fontSize = 11.sp)
        }
    }
}

// ── A-Z filter rail ──

@Composable
private fun AzFilterRail(selected: String, onSelect: (String) -> Unit) {
    val items = remember { listOf("ALL") + ('A'..'Z').map { it.toString() } + "#" }
    val listState = rememberLazyListState()
    var focusedIndex by remember { mutableStateOf(-1) }
    LaunchedEffect(focusedIndex) { if (focusedIndex >= 0) listState.animateScrollToItem(focusedIndex) }

    LazyColumn(
        state = listState, modifier = Modifier.width(44.dp).fillMaxHeight(),
        verticalArrangement = Arrangement.spacedBy(2.dp), contentPadding = PaddingValues(vertical = 2.dp)
    ) {
        items(items.size) { idx ->
            val item = items[idx]
            val active = item == selected
            var focused by remember { mutableStateOf(false) }
            val bg = when { active -> Glyph.accentPrimary.copy(alpha = 0.15f); focused -> Glyph.bgCardHover; else -> Color.Transparent }
            val textColor = when { active -> Glyph.accentPrimary; focused -> Glyph.textPrimary; else -> Glyph.textMuted }
            Box(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Glyph.radiusSm)).background(bg)
                    .border(
                        width = if (active || focused) 1.dp else 0.dp,
                        color = if (active) Glyph.borderAccent else if (focused) Glyph.borderSubtle else Color.Transparent,
                        shape = RoundedCornerShape(Glyph.radiusSm)
                    )
                    .onFocusChanged { focused = it.isFocused; if (it.isFocused) focusedIndex = idx }
                    .focusable().clickable { onSelect(item) }.padding(vertical = 5.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(if (item == "ALL") "✦" else item, color = textColor, fontSize = 12.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Normal)
            }
        }
    }
}

// ══════════════════════════════════════════
//  CONNECT SCREEN (replaces pairing)
// ══════════════════════════════════════════

@Composable
private fun ConnectScreen(
    baseUrl: String, onBaseUrlChange: (String) -> Unit,
    api: GlyphApi, onConnected: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("Nicht verbunden") }
    var loading by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary).padding(40.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.width(460.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Glyph", color = Glyph.accentPrimary, fontSize = 36.sp, fontWeight = FontWeight.ExtraBold)
            Text("Android TV", color = Glyph.textSecondary, fontSize = 16.sp)
            Spacer(Modifier.height(12.dp))
            Text("Server URL", color = Glyph.textSecondary, fontSize = 13.sp, modifier = Modifier.fillMaxWidth())
            GlyphSearchField(value = baseUrl, onValueChange = onBaseUrlChange, onSearch = {},
                modifier = Modifier.fillMaxWidth(), placeholder = "http://192.168.x.x:4000")
            Spacer(Modifier.height(4.dp))
            GlyphButton(
                text = if (loading) "Verbinde..." else "Verbinden",
                onClick = {
                    scope.launch {
                        loading = true; status = "Verbinde..."
                        try {
                            val libs = api.libraries()
                            status = "${libs.size} Libraries gefunden"
                            delay(300)
                            onConnected()
                        } catch (e: Exception) {
                            status = "Fehler: ${e.message}"
                        } finally { loading = false }
                    }
                },
                enabled = !loading, accent = true, modifier = Modifier.fillMaxWidth()
            )
            if (loading) CircularProgressIndicator(color = Glyph.accentPrimary, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
            Text(status, color = Glyph.textSecondary, fontSize = 14.sp)
        }
    }
}

// ══════════════════════════════════════════
//  HOME SCREEN
// ══════════════════════════════════════════

@Composable
private fun HomeScreen(
    api: GlyphApi, baseUrl: String,
    onOpenLibrary: (String) -> Unit, onOpenVideo: (String) -> Unit,
    onOpenSearch: () -> Unit, onOpenLibraries: () -> Unit
) {
    var loadingMain by remember { mutableStateOf(true) }
    var loadingRecent by remember { mutableStateOf(false) }
    var libraries by remember { mutableStateOf(emptyList<Library>()) }
    var continueWatching by remember { mutableStateOf(emptyList<WatchProgressItem>()) }
    var recentByLibrary by remember { mutableStateOf(emptyList<Pair<Library, List<Video>>>()) }
    var error by remember { mutableStateOf<String?>(null) }
    val hasAnyContent = libraries.isNotEmpty() || continueWatching.isNotEmpty() || recentByLibrary.isNotEmpty()
    val showBlockingLoader = loadingMain && !hasAnyContent && error == null

    LaunchedEffect(api) {
        loadingMain = true
        loadingRecent = false
        error = null
        try {
            libraries = withTimeout(15_000) { api.libraries() }
            continueWatching = runCatching { withTimeout(12_000) { api.watchProgress(20) } }.getOrDefault(emptyList())
        } catch (e: Exception) { error = e.message }
        finally { loadingMain = false }

        if (libraries.isNotEmpty()) {
            loadingRecent = true
            val collected = mutableListOf<Pair<Library, List<Video>>>()
            libraries
                .filter { it.showRecentAdded && it.id != "all" }
                .forEach { lib ->
                    val recent = runCatching {
                        withTimeout(12_000) {
                            api.libraryVideos(lib.id, sort = "date", order = "desc", limit = 10)
                        }
                    }.getOrDefault(emptyList())
                    if (recent.isNotEmpty()) {
                        collected += lib to recent
                        // incremental update -> content appears quickly without blocking full page load
                        recentByLibrary = collected.toList()
                    }
                }
            loadingRecent = false
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary)) {
        GlyphTopBar(title = "Glyph") {
            GlyphButton(text = "Suchen", onClick = onOpenSearch)
            GlyphButton(text = "Libraries", onClick = onOpenLibraries)
        }
        when {
            showBlockingLoader -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Glyph.accentPrimary) }
            error != null && !hasAnyContent -> Box(Modifier.fillMaxSize().padding(24.dp)) { Text("Fehler: $error", color = Glyph.danger) }
            else -> Box(modifier = Modifier.fillMaxSize()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp)
                ) {
                    if (error != null) {
                        item {
                            Text("Fehler: $error", color = Glyph.danger, fontSize = 13.sp)
                        }
                    }
                    // Libraries grid
                    if (libraries.isNotEmpty()) {
                        item { SectionTitle("Meine Mediathek") }
                        item {
                            val rows = (libraries.size + 2) / 3
                            LazyVerticalGrid(
                                columns = GridCells.Adaptive(minSize = 300.dp),
                                modifier = Modifier.fillMaxWidth().height((rows * 156).coerceAtMost(340).dp),
                                horizontalArrangement = Arrangement.spacedBy(16.dp),
                                verticalArrangement = Arrangement.spacedBy(16.dp)
                            ) {
                                items(libraries.size) { idx -> LibraryCard(library = libraries[idx], onClick = { onOpenLibrary(libraries[idx].id) }) }
                            }
                        }
                    }
                    // Continue watching
                    if (continueWatching.isNotEmpty()) {
                        item { SectionTitle("Weiter schauen") }
                        item {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(horizontal = 2.dp)) {
                                items(continueWatching) { video ->
                                    ContinueWatchingCard(baseUrl = baseUrl, video = video, onClick = { onOpenVideo(video.id) })
                                }
                            }
                        }
                    }
                    // Recent by library
                    recentByLibrary.forEach { (lib, videos) ->
                        item { SubSectionTitle("Neu in ${lib.name}") }
                        item {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(horizontal = 2.dp)) {
                                items(videos) { video ->
                                    RecentVideoCard(baseUrl = baseUrl, video = video, onClick = { onOpenVideo(video.id) })
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(20.dp)) }
                }
                if (loadingMain || loadingRecent) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        contentAlignment = Alignment.TopCenter
                    ) {
                        CircularProgressIndicator(
                            color = Glyph.accentPrimary,
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp
                        )
                    }
                }
            }
        }
    }
}

// ── Recent video card (for horizontal rows) ──

@Composable
private fun RecentVideoCard(baseUrl: String, video: Video, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val borderColor by animateColorAsState(if (focused) Glyph.borderAccent else Glyph.borderSubtle, tween(150), label = "")

    Column(
        modifier = Modifier.width(260.dp).clip(RoundedCornerShape(Glyph.radiusLg)).background(Glyph.bgCard)
            .border(1.dp, borderColor, RoundedCornerShape(Glyph.radiusLg))
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick)
    ) {
        VideoThumbnail(baseUrl = baseUrl, videoId = video.id, hasThumbnail = video.hasThumbnail, modifier = Modifier.fillMaxWidth())
        Column(modifier = Modifier.padding(10.dp, 8.dp)) {
            Text(video.title, color = Glyph.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (video.durationSec > 0) Text(formatDuration(video.durationSec), color = Glyph.textMuted, fontSize = 11.sp)
        }
    }
}

// ══════════════════════════════════════════
//  LIBRARIES SCREEN
// ══════════════════════════════════════════

@Composable
private fun LibrariesScreen(api: GlyphApi, onOpenLibrary: (String) -> Unit, onBack: () -> Unit) {
    var loading by remember { mutableStateOf(true) }
    var libraries by remember { mutableStateOf(emptyList<Library>()) }
    var error by remember { mutableStateOf<String?>(null) }
    val showBlockingLoader = loading && libraries.isEmpty() && error == null

    LaunchedEffect(api) {
        loading = true; error = null
        try { libraries = api.libraries() } catch (e: Exception) { error = e.message }
        finally { loading = false }
    }

    Column(modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary)) {
        GlyphTopBar(title = "Libraries", onBack = onBack)
        when {
            showBlockingLoader -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Glyph.accentPrimary) }
            error != null && libraries.isEmpty() -> Box(Modifier.padding(24.dp)) { Text("Fehler: $error", color = Glyph.danger) }
            else -> Box(modifier = Modifier.fillMaxSize()) {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 300.dp), modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(20.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    if (error != null) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Text("Fehler: $error", color = Glyph.danger, fontSize = 13.sp)
                        }
                    }
                    items(libraries.size) { idx -> LibraryCard(library = libraries[idx], onClick = { onOpenLibrary(libraries[idx].id) }) }
                }
                if (loading && libraries.isNotEmpty()) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        contentAlignment = Alignment.TopCenter
                    ) {
                        CircularProgressIndicator(
                            color = Glyph.accentPrimary,
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp
                        )
                    }
                }
            }
        }
    }
}

// ══════════════════════════════════════════
//  SEARCH SCREEN
// ══════════════════════════════════════════

@Composable
private fun SearchScreen(api: GlyphApi, baseUrl: String, onPlay: (String) -> Unit, onBack: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var videos by remember { mutableStateOf(emptyList<Video>()) }
    val scope = rememberCoroutineScope()

    fun doSearch() {
        if (query.isBlank()) return
        scope.launch {
            loading = true; error = null
            try {
                // Search across all libraries using __all_videos__ virtual library
                videos = api.libraryVideos("__all_videos__", search = query.trim(), limit = 100)
            } catch (e: Exception) { error = e.message }
            finally { loading = false }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary)) {
        GlyphTopBar(title = "Suche", onBack = onBack)
        Row(
            modifier = Modifier.fillMaxWidth().padding(20.dp, 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically
        ) {
            GlyphSearchField(value = query, onValueChange = { query = it }, onSearch = { doSearch() },
                modifier = Modifier.weight(1f), placeholder = "Titel eingeben...")
            GlyphButton(text = if (loading) "..." else "Suchen", onClick = { doSearch() }, accent = true, enabled = !loading)
        }
        if (error != null) Text("Fehler: $error", color = Glyph.danger, modifier = Modifier.padding(20.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 220.dp), modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(20.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(videos.size) { idx ->
                VideoGridCard(baseUrl = baseUrl, video = videos[idx], onClick = { onPlay(videos[idx].id) })
            }
        }
    }
}

// ══════════════════════════════════════════
//  LIBRARY CONTENT SCREEN
// ══════════════════════════════════════════

@Composable
private fun LibraryContentScreen(
    api: GlyphApi, baseUrl: String, libraryId: String,
    onOpenSeriesFolder: (String) -> Unit, onPlay: (String) -> Unit, onBack: () -> Unit
) {
    var loading by remember { mutableStateOf(true) }
    var library by remember { mutableStateOf<Library?>(null) }
    var videos by remember { mutableStateOf(emptyList<Video>()) }
    var seriesFolders by remember { mutableStateOf(emptyList<SeriesFolder>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var activeTab by rememberSaveable(libraryId) { mutableStateOf("series") }
    var queryInput by rememberSaveable(libraryId) { mutableStateOf("") }
    var appliedQuery by rememberSaveable(libraryId) { mutableStateOf("") }
    var filterLetter by rememberSaveable(libraryId) { mutableStateOf("ALL") }
    var railLetter by rememberSaveable(libraryId) { mutableStateOf("ALL") }
    val scope = rememberCoroutineScope()
    val seriesGridState = rememberLazyGridState()
    val episodeGridState = rememberLazyGridState()
    val hasAnyContent = library != null || seriesFolders.isNotEmpty() || videos.isNotEmpty()
    val showBlockingLoader = loading && !hasAnyContent && error == null

    var videosLoaded by remember { mutableStateOf(false) }

    LaunchedEffect(api, libraryId) {
        loading = true; error = null
        // Reset transient UI filters when opening a library to avoid "empty" views from stale state
        queryInput = ""
        appliedQuery = ""
        filterLetter = "ALL"
        railLetter = "ALL"
        try {
            val libs = withTimeout(15_000) { api.libraries() }
            library = libs.find { it.id == libraryId }
            val isSer = (library?.type ?: "") == "series"
            // For series libraries, load folders first (fast), defer videos
            seriesFolders = if (isSer) runCatching { withTimeout(20_000) { api.libraryFolders(libraryId) } }.getOrDefault(emptyList()) else emptyList()
            if (!isSer) {
                videos = withTimeout(30_000) { api.libraryVideos(libraryId, sort = "title", limit = 500) }
                videosLoaded = true
            }
        } catch (e: Exception) { error = e.message }
        finally { loading = false }
    }

    val isSeries = (library?.type ?: "") == "series"
    LaunchedEffect(libraryId, library?.type) {
        activeTab = if (isSeries) "series" else "episodes"
    }

    // Lazy-load videos when switching to episodes tab
    var videosLoading by remember { mutableStateOf(false) }
    LaunchedEffect(activeTab, videosLoaded) {
        if (activeTab == "episodes" && !videosLoaded && !videosLoading) {
            videosLoading = true
            try {
                videos = withTimeout(30_000) { api.libraryVideos(libraryId, sort = "title", limit = 500) }
                videosLoaded = true
            } catch (e: Exception) {
                error = e.message
            }
            finally { videosLoading = false }
        }
    }

    val normalizedQuery = appliedQuery.trim().lowercase()
    val sortedVideos = remember(videos) { videos.sortedBy { it.title.lowercase() } }
    val sortedFolders = remember(seriesFolders) { seriesFolders.sortedBy { it.name.lowercase() } }

    val filteredSeriesFolders = remember(sortedFolders, normalizedQuery, filterLetter) {
        sortedFolders.filter { folder ->
            val byText = normalizedQuery.isBlank() || folder.name.lowercase().contains(normalizedQuery)
            val byLetter = filterLetter == "ALL" || firstBucketChar(folder.name) == (if (filterLetter == "#") '#' else filterLetter.first())
            byText && byLetter
        }
    }
    val filteredVideos = remember(sortedVideos, normalizedQuery, filterLetter) {
        sortedVideos.filter { video ->
            val byText = normalizedQuery.isBlank() || video.title.lowercase().contains(normalizedQuery)
            val byLetter = filterLetter == "ALL" || firstBucketChar(video.title) == (if (filterLetter == "#") '#' else filterLetter.first())
            byText && byLetter
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary)) {
        GlyphTopBar(title = library?.name ?: "Videos", onBack = onBack)
        when {
            showBlockingLoader -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Glyph.accentPrimary) }
            error != null && !hasAnyContent -> Box(Modifier.padding(24.dp)) { Text("Fehler: $error", color = Glyph.danger) }
            else -> Box(modifier = Modifier.fillMaxSize()) {
                Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 10.dp)) {
                    if (error != null) {
                        Text("Fehler: $error", color = Glyph.danger, fontSize = 13.sp)
                        Spacer(Modifier.height(6.dp))
                    }
                    // Controls row
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (isSeries) {
                            GlyphButton(text = "Serien", onClick = {
                                activeTab = "series"; filterLetter = "ALL"; railLetter = "ALL"
                                scope.launch { seriesGridState.scrollToItem(0) }
                            }, accent = activeTab == "series")
                            GlyphButton(text = "Episoden", onClick = {
                                activeTab = "episodes"; filterLetter = "ALL"; railLetter = "ALL"
                                scope.launch { episodeGridState.scrollToItem(0) }
                            }, accent = activeTab == "episodes")
                        }
                        GlyphSearchField(value = queryInput, onValueChange = { queryInput = it },
                            onSearch = { appliedQuery = queryInput; filterLetter = "ALL"; railLetter = "ALL" }, modifier = Modifier.weight(1f))
                        GlyphButton(text = "Go", onClick = { appliedQuery = queryInput; filterLetter = "ALL"; railLetter = "ALL" }, accent = true)
                        if (appliedQuery.isNotBlank() || filterLetter != "ALL") {
                            GlyphButton(text = "Reset", onClick = { queryInput = ""; appliedQuery = ""; filterLetter = "ALL"; railLetter = "ALL" })
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    // Content + A-Z rail
                    Row(modifier = Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (activeTab == "series" && isSeries) {
                            LazyVerticalGrid(
                                columns = GridCells.Adaptive(minSize = 160.dp),
                                modifier = Modifier.weight(1f).fillMaxHeight(), state = seriesGridState,
                                contentPadding = PaddingValues(2.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                items(filteredSeriesFolders.size) { idx ->
                                    val folder = filteredSeriesFolders[idx]
                                    SeriesFolderCard(baseUrl = baseUrl, folder = folder, onClick = { onOpenSeriesFolder(folder.path) })
                                }
                            }
                        } else if (videosLoading) {
                            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.Center) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    CircularProgressIndicator(color = Glyph.accentPrimary)
                                    Text("Lade Episoden...", color = Glyph.textSecondary, fontSize = 14.sp)
                                }
                            }
                        } else {
                            LazyVerticalGrid(
                                columns = GridCells.Adaptive(minSize = 220.dp),
                                modifier = Modifier.weight(1f).fillMaxHeight(), state = episodeGridState,
                                contentPadding = PaddingValues(2.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                items(filteredVideos.size) { idx ->
                                    VideoGridCard(baseUrl = baseUrl, video = filteredVideos[idx], onClick = { onPlay(filteredVideos[idx].id) })
                                }
                            }
                        }
                        AzFilterRail(selected = railLetter, onSelect = { letter ->
                            filterLetter = letter; railLetter = letter
                            scope.launch {
                                if (activeTab == "series" && isSeries)
                                    scrollGridToLetter(seriesGridState, sortedFolders.map { it.name }, letter)
                                else
                                    scrollGridToLetter(episodeGridState, sortedVideos.map { it.title }, letter)
                            }
                        })
                    }
                }
                if (loading) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        contentAlignment = Alignment.TopCenter
                    ) {
                        CircularProgressIndicator(
                            color = Glyph.accentPrimary,
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp
                        )
                    }
                }
            }
        }
    }
}

// ══════════════════════════════════════════
//  SERIES DETAIL SCREEN
// ══════════════════════════════════════════

@Composable
private fun SeriesDetailScreen(
    api: GlyphApi, baseUrl: String, folderPath: String,
    onPlay: (String) -> Unit, onBack: () -> Unit
) {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf(SeriesDetailResponse()) }

    LaunchedEffect(api, folderPath) {
        loading = true; error = null
        try { detail = api.seriesDetail(folderPath) }
        catch (e: Exception) { error = e.message }
        finally { loading = false }
    }

    val seasonBlocks = remember(detail) {
        val blocks = mutableListOf<Pair<String, List<SeriesDetailVideo>>>()
        if (detail.directVideos.isNotEmpty()) blocks += "Episoden" to detail.directVideos
        blocks += detail.seasons.map { (it.name.ifBlank { "Staffel" }) to it.videos }
        blocks
    }
    val episodeCount = remember(detail) { detail.directVideos.size + detail.seasons.sumOf { it.videos.size } }

    Column(modifier = Modifier.fillMaxSize().background(Glyph.bgPrimary)) {
        GlyphTopBar(title = detail.name.ifBlank { "Serie" }, onBack = onBack)
        when {
            loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Glyph.accentPrimary) }
            error != null -> Box(Modifier.padding(24.dp)) { Text("Fehler: $error", color = Glyph.danger) }
            else -> {
                val hasPoster = detail.hasPoster
                val hasBackdrop = detail.metadata?.backdropPath != null || detail.metadata?.backdropIsLocal == true
                val backdropModel = when {
                    detail.metadata?.backdropIsLocal == true -> posterUrl(baseUrl, detail.path) + "&type=backdrop"
                    detail.metadata?.backdropPath != null -> "https://image.tmdb.org/t/p/w1280${detail.metadata!!.backdropPath}"
                    hasPoster -> posterUrl(baseUrl, detail.path)
                    else -> null
                }
                val posterModel = if (hasPoster) posterUrl(baseUrl, detail.path) else null

                LazyColumn(
                    modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Hero
                    item {
                        Box(modifier = Modifier.fillMaxWidth().height(280.dp).clip(RoundedCornerShape(Glyph.radiusLg))) {
                            if (backdropModel != null) {
                                AsyncImage(model = backdropModel, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            } else {
                                Box(modifier = Modifier.fillMaxSize().background(Glyph.bgTertiary))
                            }
                            Box(modifier = Modifier.fillMaxSize().background(
                                Brush.verticalGradient(listOf(Color.Transparent, Glyph.bgPrimary.copy(alpha = 0.85f), Glyph.bgPrimary))
                            ))
                            Row(
                                modifier = Modifier.align(Alignment.BottomStart).padding(20.dp),
                                horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Bottom
                            ) {
                                if (posterModel != null) {
                                    AsyncImage(
                                        model = posterModel, contentDescription = null, contentScale = ContentScale.Crop,
                                        modifier = Modifier.width(120.dp).aspectRatio(2f / 3f)
                                            .clip(RoundedCornerShape(Glyph.radiusMd))
                                            .border(1.dp, Glyph.borderSubtle, RoundedCornerShape(Glyph.radiusMd))
                                    )
                                }
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(detail.name.ifBlank { "Serie" }, color = Glyph.textPrimary, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                                    Text("${detail.seasons.size} Staffeln • $episodeCount Episoden", color = Glyph.textSecondary, fontSize = 14.sp)
                                    detail.metadata?.overview?.let { overview ->
                                        Text(overview, color = Glyph.textMuted, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
                    // Seasons
                    seasonBlocks.forEach { (seasonName, videos) ->
                        if (videos.isNotEmpty()) {
                            item { SubSectionTitle(seasonName) }
                            item {
                                val rows = (videos.size + 3) / 4
                                LazyVerticalGrid(
                                    columns = GridCells.Adaptive(minSize = 220.dp),
                                    modifier = Modifier.fillMaxWidth().height((rows * 200).coerceAtMost(600).dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    items(videos.size) { idx ->
                                        val v = videos[idx]
                                        VideoGridCard(
                                            baseUrl = baseUrl,
                                            video = Video(id = v.id, title = v.title, hasThumbnail = v.hasThumbnail, durationSec = v.durationSec),
                                            onClick = { onPlay(v.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(20.dp)) }
                }
            }
        }
    }
}

// ══════════════════════════════════════════
//  PLAYER SCREEN
// ══════════════════════════════════════════

@Composable
private fun PlayerScreen(
    api: GlyphApi, baseUrl: String, videoId: String, onBack: () -> Unit
) {
    var playerError by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Keep screen on
    DisposableEffect(Unit) {
        val window = (context as? ComponentActivity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    // Use direct play URL (no transcoding, best quality)
    val playUrl = directPlayUrl(baseUrl, videoId)
    val streamFallbackUrl = streamUrl(baseUrl, videoId)

    val exoPlayer = remember(videoId) {
        val httpFactory = DefaultHttpDataSource.Factory().apply {
            setAllowCrossProtocolRedirects(true)
        }
        // Try direct play first (ProgressiveMediaSource)
        val mediaSource = ProgressiveMediaSource.Factory(httpFactory)
            .createMediaSource(MediaItem.fromUri(Uri.parse(playUrl)))

        ExoPlayer.Builder(context).build().apply {
            setMediaSource(mediaSource)
            prepare()
            playWhenReady = true
        }
    }

    // Watch progress tracking
    LaunchedEffect(exoPlayer, videoId) {
        while (true) {
            delay(10_000)
            val pos = exoPlayer.currentPosition / 1000.0
            val dur = exoPlayer.duration.let { if (it > 0) it / 1000.0 else 0.0 }
            if (pos > 5 && dur > 0) {
                runCatching { api.updateWatchProgress(WatchProgressUpdate(videoId, pos, dur)) }
            }
        }
    }

    // Error listener - fallback to stream on direct play failure
    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onPlayerError(err: PlaybackException) {
                // Fallback: try transcoded stream
                val httpFactory = DefaultHttpDataSource.Factory().apply {
                    setAllowCrossProtocolRedirects(true)
                }
                val fallbackSource = ProgressiveMediaSource.Factory(httpFactory)
                    .createMediaSource(MediaItem.fromUri(Uri.parse(streamFallbackUrl)))
                exoPlayer.setMediaSource(fallbackSource)
                exoPlayer.prepare()
                exoPlayer.playWhenReady = true
                playerError = null
            }
        }
        exoPlayer.addListener(listener)
        onDispose { exoPlayer.removeListener(listener); exoPlayer.release() }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = true
                    player = exoPlayer
                    keepScreenOn = true
                }
            },
            update = { view -> view.player = exoPlayer }
        )
        // Back button overlay (top-left)
        Box(
            modifier = Modifier.align(Alignment.TopStart).padding(16.dp)
                .clip(RoundedCornerShape(Glyph.radiusSm))
                .background(Glyph.bgPrimary.copy(alpha = 0.7f))
                .clickable(onClick = onBack)
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text("← Zurück", color = Glyph.textPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
        // Error overlay
        if (!playerError.isNullOrBlank()) {
            Column(
                modifier = Modifier.align(Alignment.Center)
                    .clip(RoundedCornerShape(Glyph.radiusMd))
                    .background(Glyph.bgPrimary.copy(alpha = 0.9f))
                    .border(1.dp, Glyph.danger.copy(alpha = 0.5f), RoundedCornerShape(Glyph.radiusMd))
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("Playback-Fehler", color = Glyph.danger, fontWeight = FontWeight.Bold)
                Text(playerError!!, color = Glyph.textSecondary, fontSize = 13.sp)
                GlyphButton(text = "Zurück", onClick = onBack)
            }
        }
    }
}

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════

private suspend fun scrollGridToLetter(state: LazyGridState, titles: List<String>, letter: String) {
    if (titles.isEmpty()) return
    val targetIndex = if (letter == "ALL") 0
    else {
        val target = if (letter == "#") '#' else letter.firstOrNull()?.uppercaseChar() ?: '#'
        titles.indexOfFirst { firstBucketChar(it) == target }.let { if (it >= 0) it else 0 }
    }
    state.animateScrollToItem(targetIndex)
}

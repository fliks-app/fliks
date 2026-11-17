package media.fliks.app;

import android.Manifest;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Karaoke microphone with the platform echo canceller: the WebView's own one would switch the phone to call audio. */
@CapacitorPlugin(name = "KaraokeMic", permissions = @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"))
public class KaraokeMicPlugin extends Plugin {
    private static final int RATE = 48000;
    private static final int BLOCK = 1024;

    private AudioRecord record;
    private AcousticEchoCanceler echo;
    private Thread reader;

    @PluginMethod()
    public void start(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) open(call);
        else requestPermissionForAlias("microphone", call, "onPermission");
    }

    @PermissionCallback
    private void onPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) open(call);
        else call.reject("denied");
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        close();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        close();
    }

    private synchronized void open(PluginCall call) {
        close();
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, BLOCK * 8));
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            call.reject("unavailable");
            return;
        }
        record = r;
        if (AcousticEchoCanceler.isAvailable()) {
            echo = AcousticEchoCanceler.create(r.getAudioSessionId());
            if (echo != null) echo.setEnabled(true);
        }
        r.startRecording();
        reader = new Thread(() -> read(r), "karaoke-mic");
        reader.start();
        call.resolve(new JSObject().put("sampleRate", RATE).put("echoCancelled", echo != null));
    }

    private void read(AudioRecord r) {
        short[] block = new short[BLOCK];
        ByteBuffer bytes = ByteBuffer.allocate(BLOCK * 2).order(ByteOrder.LITTLE_ENDIAN);
        while (!Thread.currentThread().isInterrupted()) {
            int got = 0;
            while (got < BLOCK) {
                int n = r.read(block, got, BLOCK - got);
                if (n <= 0) return;
                got += n;
            }
            bytes.clear();
            bytes.asShortBuffer().put(block);
            notifyListeners("block", new JSObject().put("data", Base64.encodeToString(bytes.array(), Base64.NO_WRAP)));
        }
    }

    private synchronized void close() {
        if (reader != null) reader.interrupt();
        reader = null;
        if (echo != null) echo.release();
        echo = null;
        if (record != null) {
            record.stop();
            record.release();
        }
        record = null;
    }
}

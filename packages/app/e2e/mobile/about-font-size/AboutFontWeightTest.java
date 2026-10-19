package sh.paseo.diagnosis;

import android.content.Context;
import android.content.res.Configuration;
import android.text.Layout;
import android.text.Spannable;
import android.util.Log;
import android.view.View;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.common.mapbuffer.WritableMapBuffer;
import com.facebook.react.soloader.OpenSourceMergedSoMapping;
import com.facebook.react.uimanager.DisplayMetricsHolder;
import com.facebook.react.uimanager.PixelUtil;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.views.text.ReactTextUpdate;
import com.facebook.react.views.text.ReactTextView;
import com.facebook.react.views.text.TextLayoutManager;
import com.facebook.soloader.SoLoader;
import com.facebook.yoga.YogaMeasureMode;
import com.facebook.yoga.YogaMeasureOutput;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Native reproduction for #4368. Uses the measurement and rendering paths used by RN Text. */
@RunWith(AndroidJUnit4.class)
public class AboutFontWeightTest {
  @Test public void ordinaryVersionFitsItsMeasuredBox() { checkVersion(0); }
  @Test public void boldVersionFitsItsMeasuredBox() { checkVersion(300); }

  private void checkVersion(int adjustment) {
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
      Configuration configuration = new Configuration(app.getResources().getConfiguration());
      configuration.fontWeightAdjustment = adjustment;
      Context configured = app.createConfigurationContext(configuration);
      try {
        SoLoader.init(app, OpenSourceMergedSoMapping.INSTANCE);
      } catch (java.io.IOException error) {
        throw new AssertionError("Could not initialize React Native", error);
      }
      DisplayMetricsHolder.initDisplayMetrics(configured);
      ThemedReactContext context = new ThemedReactContext(new BridgeReactContext(configured), configured);

      WritableMapBuffer attributes = new WritableMapBuffer();
      attributes.put(4, 15.0); // TextAttributeProps.TA_KEY_FONT_SIZE
      attributes.put(9, true); // TextAttributeProps.TA_KEY_ALLOW_FONT_SCALING
      WritableMapBuffer fragment = new WritableMapBuffer();
      fragment.put(0, "v0.12.0");
      fragment.put(1, 1);
      fragment.put(5, attributes);
      WritableMapBuffer fragments = new WritableMapBuffer();
      fragments.put(0, fragment);
      WritableMapBuffer text = new WritableMapBuffer();
      text.put(1, "v0.12.0");
      text.put(2, fragments);
      text.put(4, attributes);
      WritableMapBuffer paragraph = new WritableMapBuffer();
      paragraph.put(2, "highQuality");
      paragraph.put(5, "none");

      long measured = TextLayoutManager.measureText(context, text, paragraph,
          1000, YogaMeasureMode.AT_MOST, 1000, YogaMeasureMode.AT_MOST, null, null);
      int width = (int) Math.ceil(PixelUtil.toPixelFromDIP(YogaMeasureOutput.getWidth(measured)));
      int height = (int) Math.ceil(PixelUtil.toPixelFromDIP(YogaMeasureOutput.getHeight(measured)));
      Spannable content = TextLayoutManager.INSTANCE.getOrCreateSpannableForText(context, text, null);
      ReactTextView view = new ReactTextView(context);
      view.setId(2); // Fabric tag, matching the app's new-architecture Text path.
      view.setText(new ReactTextUpdate(content, -1, false, 0,
          Layout.BREAK_STRATEGY_HIGH_QUALITY, Layout.JUSTIFICATION_MODE_NONE));
      view.measure(exact(width), exact(height));
      view.layout(0, 0, width, height);
      Layout rendered = view.getLayout();
      Log.i("AboutFontWeightTest", "adjustment=" + adjustment + " box=" + width + "x" + height
          + " lines=" + rendered.getLineCount() + " lineWidth=" + rendered.getLineWidth(0)
          + " weight=" + view.getTypeface().getWeight());
      assertEquals("The complete version should fit on its measured line", 1, rendered.getLineCount());
      assertTrue("The last digit must remain inside the allocated width",
          rendered.getLineWidth(0) <= width);
      assertTrue("The complete line must remain inside the allocated height",
          rendered.getLineBottom(0) <= height);
    });
  }

  private static int exact(int size) {
    return View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY);
  }
}

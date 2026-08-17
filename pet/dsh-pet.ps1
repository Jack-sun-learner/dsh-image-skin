# dsh-pet.ps1 — 桌面宠物（独立置顶窗口，活在主屏幕上，与 DSH 浏览器窗口无关）
# 用法: powershell -ExecutionPolicy Bypass -File dsh-pet.ps1 -Preset cat -Size 150
# 行为: 打招呼 -> 30s 无互动躲到右侧屏幕边缘 -> 悬停探出 -> 左键拖拽自由摆放
#       -> DSH agent 运作中进入思考状态（轮询宿主 /api/dsh-image-skin/busy）
# 位置保存在本目录 pet-pos.json；右键关闭窗口。
param(
  [string]$Preset = 'cat',
  [int]$Size = 150
)
# Boot log: helps diagnose launches that exit silently.
$bootLog = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'pet-boot.log'
function Log-Boot([string]$msg) {
  try { Add-Content -Path $bootLog -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $msg) -Encoding UTF8 } catch { }
}
Log-Boot 'start'
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Log-Boot 'assemblies loaded'

# Win32 positioning: WPF Left/Top can land off-screen on ghost/virtual displays,
# so all placement uses physical screen coordinates via SetWindowPos.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PetWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Rect(IntPtr hWnd) {
    RECT r; if (GetWindowRect(hWnd, out r)) return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    return "";
  }
}
'@

$script:Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AssetDir = Join-Path $script:Dir 'assets'
$script:PosFile = Join-Path $script:Dir 'pet-pos.json'
$script:Preset = if ($Preset -match '^[a-z]+$') { $Preset } else { 'cat' }
$script:Size = [Math]::Max(60, [Math]::Min(240, $Size))
$script:BubbleH = 70
$script:Mood = 'idle'
$script:Busy = $false
$script:Dragging = $false
$script:Hidden = $false
$script:Hwnd = [IntPtr]::Zero
$script:NormalLeft = $null
$script:NormalTop = $null
$script:CurAnim = $null
$script:GreetTimer = $null
$script:HideTimer = $null
$script:MsgTimer = $null
$script:SlideTimer = $null
$script:SlideTarget = $null
$script:SlideDone = $null
$script:InfoExpanded = $true

# ---------------------------------------------------------------- XAML shell
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="$($script:Size)" Height="$($script:Size + $script:BubbleH)"
        AllowsTransparency="True" WindowStyle="None" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        Cursor="Hand">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="$script:BubbleH"/>
      <RowDefinition Height="*"/>
    </Grid.RowDefinitions>
    <Border x:Name="Bubble" Grid.Row="0" HorizontalAlignment="Center" VerticalAlignment="Center"
            Background="White" CornerRadius="10" Padding="9,4" Visibility="Collapsed">
      <Border.Effect>
        <DropShadowEffect BlurRadius="8" ShadowDepth="1" Opacity="0.25"/>
      </Border.Effect>
      <TextBlock x:Name="BubbleText" FontSize="12" Foreground="#333333" Text=""/>
    </Border>
    <!-- Collapsible agent-activity info panel (shown while DSH is minimized) -->
    <Border x:Name="InfoPanel" Grid.Row="0" VerticalAlignment="Top" HorizontalAlignment="Stretch"
            Background="#E61B2233" CornerRadius="8" Margin="0,2,0,0" Padding="7,4"
            MaxWidth="$($script:Size - 6)" Visibility="Collapsed" Cursor="Hand">
      <Border.Effect>
        <DropShadowEffect BlurRadius="8" ShadowDepth="1" Opacity="0.35"/>
      </Border.Effect>
      <StackPanel>
        <DockPanel>
          <TextBlock x:Name="InfoFold" DockPanel.Dock="Right" FontSize="10" Foreground="#88A0B8" Text="&#9662;" Margin="6,0,0,0" VerticalAlignment="Top"/>
          <TextBlock x:Name="InfoText" FontSize="11" Foreground="#FFE8EAF0" TextWrapping="Wrap" MaxHeight="60" Text=""/>
        </DockPanel>
      </StackPanel>
    </Border>
    <Image x:Name="Pet" Grid.Row="1" Width="$($script:Size)" Height="$($script:Size)"
           HorizontalAlignment="Center" VerticalAlignment="Bottom"
           Stretch="Fill"/>
  </Grid>
</Window>
"@
$window = [Windows.Markup.XamlReader]::Parse($xaml)
$pet = $window.FindName('Pet')
$bubble = $window.FindName('Bubble')
$bubbleText = $window.FindName('BubbleText')
$infoPanel = $window.FindName('InfoPanel')
$infoText = $window.FindName('InfoText')
$infoFold = $window.FindName('InfoFold')

# render transform group: [0]=scale [1]=rotate [2]=translateY
$scale = New-Object Windows.Media.ScaleTransform 1, 1
$rotate = New-Object Windows.Media.RotateTransform 0
$translate = New-Object Windows.Media.TranslateTransform 0, 0
$group = New-Object Windows.Media.TransformGroup
[void]$group.Children.Add($scale)
[void]$group.Children.Add($rotate)
[void]$group.Children.Add($translate)
$pet.RenderTransform = $group

# ---------------------------------------------------------------- helpers
function Set-Image([string]$name) {
  $src = Join-Path $script:AssetDir "$($script:Preset)-$name.png"
  if (Test-Path $src) {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource = New-Object Uri $src
    $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.EndInit()
    $pet.Source = $bmp
  }
}

function Set-Source([string]$mood) { Set-Image $mood }

# ---- frame-sequence player (Codex-style: per-frame PNGs + timed switching) ----
$script:FrameTimer = $null
$script:FrameList = $null
$script:FrameMs = 0
$script:FrameIdx = 0
$script:FrameLoops = 0
$script:FrameLoopsLeft = 0
$script:FrameOnDone = $null

function Stop-Frames {
  if ($script:FrameTimer) { $script:FrameTimer.Stop(); $script:FrameTimer = $null }
  $script:FrameList = $null
  $script:FrameOnDone = $null
}

function Set-Frames([string[]]$names, [int]$ms, [int]$loops, [string]$onDone) {
  Stop-Frames
  if ($names.Length -eq 0) { return }
  $script:FrameList = $names
  $script:FrameMs = [Math]::Max(30, $ms)
  $script:FrameIdx = 0
  $script:FrameLoops = $loops
  $script:FrameLoopsLeft = $loops
  $script:FrameOnDone = $onDone
  Set-Image $names[0]
  if ($names.Length -lt 2) { return }
  $t = New-Object Windows.Threading.DispatcherTimer
  $t.Interval = [TimeSpan]::FromMilliseconds($script:FrameMs)
  $script:FrameTimer = $t
  $t.Add_Tick({
    $script:FrameIdx++
    if ($script:FrameIdx -ge $script:FrameList.Length) {
      if ($script:FrameLoops -eq 0) {
        $script:FrameIdx = 0
      } elseif ($script:FrameLoopsLeft -gt 1) {
        $script:FrameLoopsLeft--
        $script:FrameIdx = 0
      } else {
        $script:FrameTimer.Stop()
        $script:FrameTimer = $null
        $done = $script:FrameOnDone
        $script:FrameOnDone = $null
        if ($done) { & $done }
        return
      }
    }
    Set-Image $script:FrameList[$script:FrameIdx]
  })
  $t.Start()
}

function Stop-Anim {
  if ($script:CurAnim) { $script:CurAnim.Stop($pet); $script:CurAnim.Remove($pet); $script:CurAnim = $null }
  $scale.ScaleX = 1; $scale.ScaleY = 1
  $rotate.Angle = 0
  $translate.Y = 0
}

function New-Anim([string]$propPath, $from, $to, [double]$durSec, [bool]$auto, $reps, [bool]$forever) {
  $anim = New-Object Windows.Media.Animation.DoubleAnimation
  if ($null -ne $from) { $anim.From = [double]$from }
  $anim.To = [double]$to
  $anim.Duration = New-Object Windows.Duration ([TimeSpan]::FromSeconds($durSec))
  $anim.AutoReverse = $auto
  if ($forever) { $anim.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever }
  elseif ($null -ne $reps) { $anim.RepeatBehavior = New-Object Windows.Media.Animation.RepeatBehavior ([int]$reps) }
  $sb = New-Object Windows.Media.Animation.Storyboard
  [void]$sb.Children.Add($anim)
  [Windows.Media.Animation.Storyboard]::SetTarget($anim, $pet)
  [Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, [Windows.PropertyPath]::new($propPath))
  $sb.Begin($pet, $true)
  $script:CurAnim = $sb
}

function Set-Bubble([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { $bubble.Visibility = 'Collapsed'; return }
  $bubbleText.Text = $text
  $bubble.Visibility = 'Visible'
}

# ---- collapsible agent-activity info panel ----
$script:InfoTextValue = ''
function Set-Info([string]$text) {
  $script:InfoTextValue = $text
  if ([string]::IsNullOrEmpty($text)) { $infoPanel.Visibility = 'Collapsed'; return }
  if ($script:InfoExpanded) {
    $infoText.Text = $script:InfoTextValue
    $infoPanel.Height = [Double]::NaN
    $infoFold.Text = [string][char]0x25BE
  } else {
    $infoText.Text = '…'
    $infoPanel.Height = 16
    $infoFold.Text = [string][char]0x25B4
  }
  $infoPanel.Visibility = 'Visible'
}
$infoPanel.Add_MouseLeftButtonUp({
  $script:InfoExpanded = -not $script:InfoExpanded
  Set-Info $script:InfoTextValue
})

# Physical-coordinate placement (works regardless of WPF's DIP coordinate space).
function Set-WindowPos([double]$x, [double]$y) {
  if ($script:Hwnd -eq [IntPtr]::Zero) { return }
  [PetWin]::SetWindowPos($script:Hwnd, [IntPtr]::Zero, [int]$x, [int]$y, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) | Out-Null
}

function Get-WindowPos {
  $r = [PetWin]::Rect($script:Hwnd)
  if ($r) { $parts = $r -split ','; return @{ left = [int]$parts[0]; top = [int]$parts[1] } }
  return @{ left = $window.Left; top = $window.Top }
}

# Smooth horizontal slide to a target left edge (physical px). Plays the "run"
# frame sequence while moving; calls $onDone when arrived.
function Slide-To([double]$targetLeft, [string]$onDone) {
  if ($script:SlideTimer) { $script:SlideTimer.Stop(); $script:SlideTimer = $null }
  $script:SlideTarget = $targetLeft
  $script:SlideDone = $onDone
  Set-Frames @('run-0', 'run-1') 130 0 $null
  $t = New-Object Windows.Threading.DispatcherTimer
  $t.Interval = [TimeSpan]::FromMilliseconds(16)
  $script:SlideTimer = $t
  $t.Add_Tick({
    $pos = Get-WindowPos
    $cur = $pos.left
    $diff = $script:SlideTarget - $cur
    if ([Math]::Abs($diff) -lt 8) {
      $script:SlideTimer.Stop()
      $script:SlideTimer = $null
      Set-WindowPos $script:SlideTarget $script:NormalTop
      Stop-Frames
      $done = $script:SlideDone
      $script:SlideDone = $null
      if ($done) { & $done }
      return
    }
    Set-WindowPos ($cur + $diff * 0.18) $script:NormalTop
  })
  $t.Start()
}

function Clear-MsgTimer {
  if ($script:MsgTimer) { $script:MsgTimer.Stop(); $script:MsgTimer = $null }
}

function Start-HideTimer {
  if ($script:HideTimer) { $script:HideTimer.Stop(); $script:HideTimer = $null }
  $t = New-Object Windows.Threading.DispatcherTimer
  $t.Interval = [TimeSpan]::FromSeconds(30)
  $script:HideTimer = $t
  $t.Add_Tick({
    $script:HideTimer.Stop()
    if ($script:Mood -eq 'idle' -and -not $script:Busy -and -not $script:Dragging) { Hide-AtEdge }
  })
  $t.Start()
}

function Hide-AtEdge {
  $script:Hidden = $true
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  # Leave 70% of the pet visible at the right edge so it stays easy to find.
  $script:SlideTarget = $screen.Right - [int]($script:Size * 0.70)
  Slide-To $script:SlideTarget 'Hide-Done'
}

function Hide-Done {
  Set-Mood 'sleepy'
}

function Pop-Out {
  $script:Hidden = $false
  if ($null -ne $script:NormalLeft) {
    Slide-To $script:NormalLeft 'Pop-Done'
  } else {
    Set-Mood 'alert'
    Start-AlertTimer
  }
}

function Pop-Done {
  Set-Mood 'alert'
  Start-AlertTimer
}

function Start-AlertTimer {
  Clear-MsgTimer
  $mt = New-Object Windows.Threading.DispatcherTimer
  $mt.Interval = [TimeSpan]::FromMilliseconds(1500)
  $script:MsgTimer = $mt
  $mt.Add_Tick({ $script:MsgTimer.Stop(); if ($script:Mood -eq 'alert') { Set-Mood 'idle' } })
  $mt.Start()
}

function Set-Mood([string]$m) {
  $script:Mood = $m
  Stop-Anim
  Stop-Frames
  switch ($m) {
    'happy' {
      # Greeting: wave frames (Codex-style waving), then settle.
      Set-Frames @('happy-0', 'happy-1', 'happy-2', 'happy-3') 150 2 $null
      Set-Bubble '嗨，我来啦～'
      Clear-MsgTimer
      $gt = New-Object Windows.Threading.DispatcherTimer
      $gt.Interval = [TimeSpan]::FromSeconds(4)
      $script:GreetTimer = $gt
      $gt.Add_Tick({ $script:GreetTimer.Stop(); if ($script:Mood -eq 'happy') { Set-Mood 'idle' } })
      $gt.Start()
    }
    'idle' {
      Set-Frames @('normal-0') 500 0 $null
      Set-Bubble $null
      Start-HideTimer
    }
    'alert' {
      # Hover/pop-out response: jump up (Codex-style "jumping").
      Set-Frames @('happy-0') 500 0 $null
      New-Anim '(UIElement.RenderTransform).(TransformGroup.Children)[2].(TranslateTransform.Y)' 0 -22 0.28 $true 2 $false
      New-Anim '(UIElement.RenderTransform).(TransformGroup.Children)[0].(ScaleTransform.ScaleX)' 1 1.10 0.28 $true 2 $false
      New-Anim '(UIElement.RenderTransform).(TransformGroup.Children)[0].(ScaleTransform.ScaleY)' 1 1.10 0.28 $true 2 $false
      Set-Bubble '嗨！'
    }
    'grabbed' {
      Set-Frames @('grabbed-0') 500 0 $null
      New-Anim '(UIElement.RenderTransform).(TransformGroup.Children)[1].(RotateTransform.Angle)' -10 -18 0.28 $true $null $true
      Set-Bubble '放我下来！'
    }
    'think' {
      # Thinking: tilt-head frames (Codex-style waiting/thinking).
      Set-Frames @('think-0', 'think-1', 'think-2') 700 0 $null
      Set-Bubble '思考中…'
    }
    'sleepy' {
      # Nodding-off frames while hiding at the edge.
      Set-Frames @('sleepy-0', 'sleepy-1') 900 0 $null
      # "zZ" bubble helps the user spot the pet while it hides at the edge.
      Set-Bubble 'zZ…'
    }
  }
}

function Save-Pos {
  try {
    $pos = Get-WindowPos
    $save = @{ left = $pos.left; top = $pos.top }
    $save | ConvertTo-Json | Set-Content -Path $script:PosFile -Encoding UTF8
  } catch { }
}

# ---------------------------------------------------------------- window events
$window.Add_MouseLeftButtonDown({
  $script:Dragging = $true
  $pos = Get-WindowPos
  $script:DragOffsetX = [System.Windows.Forms.Cursor]::Position.X - $pos.left
  $script:DragOffsetY = [System.Windows.Forms.Cursor]::Position.Y - $pos.top
  Set-Mood 'grabbed'
  try { $window.CaptureMouse() } catch { }
})
$window.Add_MouseMove({
  if ($script:Dragging) {
    Set-WindowPos ([System.Windows.Forms.Cursor]::Position.X - $script:DragOffsetX) ([System.Windows.Forms.Cursor]::Position.Y - $script:DragOffsetY)
  }
})
$window.Add_MouseLeftButtonUp({
  if ($script:Dragging) {
    $script:Dragging = $false
    try { $window.ReleaseMouseCapture() } catch { }
    $pos = Get-WindowPos
    $script:NormalLeft = $pos.left
    $script:NormalTop = $pos.top
    Save-Pos
    if ($script:Busy) { Set-Mood 'think' } else { Set-Mood 'idle' }
  }
})
$window.Add_MouseEnter({
  if ($script:Hidden) { Pop-Out }
  elseif ($script:Mood -eq 'idle') {
    Set-Mood 'alert'
    Clear-MsgTimer
    $mt = New-Object Windows.Threading.DispatcherTimer
    $mt.Interval = [TimeSpan]::FromMilliseconds(1500)
    $script:MsgTimer = $mt
    $mt.Add_Tick({ $script:MsgTimer.Stop(); if ($script:Mood -eq 'alert' -and -not $script:Dragging) { Set-Mood 'idle' } })
    $mt.Start()
  }
})
$window.Add_MouseLeave({
  if (-not $script:Dragging -and $script:Mood -eq 'alert') { Set-Mood 'idle' }
})
$window.Add_MouseRightButtonUp({ try { Save-Pos } catch { }; $window.Close() })
$window.Add_Closed({ try { Save-Pos } catch { }; try { [System.Windows.Threading.Dispatcher]::ExitAllFrames() } catch { } })

# ---------------------------------------------------------------- busy polling
$poll = New-Object Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromSeconds(2.5)
$poll.Add_Tick({
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/dsh-image-skin/busy' -TimeoutSec 4
    $b = [bool]$r.busy
    $act = [string]$r.activity
    $ui = if ($null -eq $r.uiVisible) { $true } else { [bool]$r.uiVisible }
    if ($b -and -not $script:Busy) {
      $script:Busy = $true
      if (-not $script:Dragging) {
        if ($script:Hidden) { Pop-Out } else { Set-Mood 'think' }
      }
    } elseif (-not $b -and $script:Busy) {
      $script:Busy = $false
      if ($script:Mood -eq 'think') {
        Set-Bubble '搞定啦！'
        Clear-MsgTimer
        $mt = New-Object Windows.Threading.DispatcherTimer
        $mt.Interval = [TimeSpan]::FromSeconds(2)
        $script:MsgTimer = $mt
        $mt.Add_Tick({ $script:MsgTimer.Stop(); if ($script:Mood -eq 'think' -or $script:Mood -eq 'idle') { Set-Mood 'idle' } })
        $mt.Start()
      }
    }
    # Info panel: while DSH is minimized and the agent is busy, show the
    # collapsible activity panel instead of the speech bubble.
    if ($script:Busy -and -not $ui) {
      if ($act) {
        Set-Info $act
        Set-Bubble $null
      }
    } else {
      Set-Info $null
    }
  } catch { }
})
$poll.Start()

# ---------------------------------------------------------------- position & start
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$saved = $null
try { $saved = Get-Content $script:PosFile -Raw | ConvertFrom-Json } catch { }
if ($saved -and $saved.left -ne $null) {
  $script:NormalLeft = [double]$saved.left
  $script:NormalTop = [double]$saved.top
} else {
  # Bottom-right of the primary screen's working area, in PHYSICAL pixels.
  $script:NormalLeft = [double]($screen.Right - $script:Size - 24)
  $script:NormalTop = [double]($screen.Bottom - $script:Size - 24)
}
# Left/Top are only bookkeeping here; actual placement happens after Show()
# via SetWindowPos so the window lands on the real screen even when WPF's
# coordinate space is off (ghost/virtual displays).

$window.Show()
Log-Boot 'window shown'
$script:Hwnd = (New-Object Windows.Interop.WindowInteropHelper($window)).Handle
Log-Boot ('hwnd ' + $script:Hwnd)
Set-WindowPos $script:NormalLeft $script:NormalTop
Log-Boot ('pos ' + $script:NormalLeft + ',' + $script:NormalTop)
Set-Mood 'happy'
Log-Boot 'mood happy'
# Block on the dispatcher until the window closes (Closed -> ExitAllFrames).
[System.Windows.Threading.Dispatcher]::Run()
Log-Boot 'dispatcher exited'









